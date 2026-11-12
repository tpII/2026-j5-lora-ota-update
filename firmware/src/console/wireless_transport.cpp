#include "wireless_transport.h"

#include <WiFi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../configuration.h"
#include "../protocol/protocol_contract.h"
#include "command_line.h"

namespace firmware {

static constexpr size_t INBOUND_QUEUE_LENGTH = 8;
static constexpr uint16_t MAXIMUM_PENDING_OUTBOUND = 32;
// Longer messages close the connection; shorter ones over the line limit are read and discarded.
static constexpr size_t MAXIMUM_MESSAGE_SIZE = 2 * MAXIMUM_COMMAND_LINE_LENGTH;
// The network of the access point: the node and its clients, which the DHCP server of the core
// numbers after the node.
static const IPAddress ACCESS_POINT_SUBNET_MASK(255, 255, 255, 0);

namespace {

// Reserved with the length of each message, because a load_image line is many times longer than
// any other command.
struct InboundLine {
  bool overflowed;
  char text[1];
};

struct OutboundLine {
  WirelessTransport *transport;
  size_t length;
  char text[1];
};

} // namespace

static void trimLineEnd(char *text) {
  size_t length = strlen(text);
  while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r')) {
    text[--length] = '\0';
  }
}

bool WirelessTransport::begin(uint16_t nodeId) {
  snprintf(ssid_, sizeof(ssid_), ACCESS_POINT_NAME_FORMAT, nodeId);
  return startAccessPoint();
}

bool WirelessTransport::start() {
  const bool started = startAccessPoint();
  change_.store(static_cast<uint8_t>(WirelessChange::Switched));
  return started;
}

void WirelessTransport::stop() {
  stopAccessPoint();
  change_.store(static_cast<uint8_t>(WirelessChange::Switched));
}

WirelessChange WirelessTransport::takeStateChange() {
  return static_cast<WirelessChange>(change_.exchange(static_cast<uint8_t>(WirelessChange::None)));
}

void WirelessTransport::noteClientChange() {
  // A Switched change waiting to be taken already reports the clients.
  uint8_t expected = static_cast<uint8_t>(WirelessChange::None);
  change_.compare_exchange_strong(expected, static_cast<uint8_t>(WirelessChange::Clients));
}

void WirelessTransport::resetClientSockets() {
  for (int &socket : clientSockets_) {
    socket = -1;
  }
  connectedClients_.store(0);
}

void WirelessTransport::addClient(int socket) {
  for (int &slot : clientSockets_) {
    if (slot == socket) {
      return;
    }
  }
  for (int &slot : clientSockets_) {
    if (slot < 0) {
      slot = socket;
      connectedClients_.fetch_add(1);
      noteClientChange();
      return;
    }
  }
}

void WirelessTransport::removeClient(int socket) {
  for (int &slot : clientSockets_) {
    if (slot == socket) {
      slot = -1;
      connectedClients_.fetch_sub(1);
      noteClientChange();
      return;
    }
  }
}

void WirelessTransport::closeSession(httpd_handle_t handle, int socket) {
  static_cast<WirelessTransport *>(httpd_get_global_user_ctx(handle))->removeClient(socket);
  close(socket);
}

// The server frees its global context when it stops, unless a function of its own does it; the
// transport is not the server's to free.
void WirelessTransport::keepGlobalContext(void *) {}

esp_err_t WirelessTransport::handleConsole(httpd_req_t *request) {
  WirelessTransport &transport = *static_cast<WirelessTransport *>(request->user_ctx);
  // ESP-IDF 5.5.5, the base of core 3.3.12, completes the handshake without calling this handler,
  // so a client is registered when its first message arrives; the control panel sends status as
  // soon as the socket opens. Earlier releases also call it once with the handshake request.
  transport.addClient(httpd_req_to_sockfd(request));
  if (request->method == HTTP_GET) {
    return ESP_OK;
  }

  httpd_ws_frame_t frame = {};
  esp_err_t result = httpd_ws_recv_frame(request, &frame, 0);
  if (result != ESP_OK) {
    return result;
  }

  if (frame.len > MAXIMUM_MESSAGE_SIZE) {
    return ESP_FAIL;
  }
  // Every message is read whole so the connection stays in step, even one that is discarded.
  InboundLine *line = static_cast<InboundLine *>(malloc(sizeof(InboundLine) + frame.len));
  if (line == nullptr) {
    return ESP_ERR_NO_MEM;
  }
  frame.payload = reinterpret_cast<uint8_t *>(line->text);
  result = frame.len > 0 ? httpd_ws_recv_frame(request, &frame, frame.len) : ESP_OK;
  if (result != ESP_OK || frame.type != HTTPD_WS_TYPE_TEXT) {
    free(line);
    return result;
  }
  line->text[frame.len] = '\0';
  trimLineEnd(line->text);
  line->overflowed = strlen(line->text) > MAXIMUM_COMMAND_LINE_LENGTH;
  if (line->overflowed) {
    // Only the first word is kept, to name the command in the error.
    char *firstWord = line->text + strspn(line->text, " ");
    firstWord[strcspn(firstWord, " ")] = '\0';
  }

  // A full queue drops the command; the operator sees no reply and can repeat it.
  if (xQueueSend(transport.inboundQueue_, &line, 0) != pdTRUE) {
    free(line);
  }
  return ESP_OK;
}

void WirelessTransport::sendOutboundLine(void *argument) {
  OutboundLine *line = static_cast<OutboundLine *>(argument);
  WirelessTransport &transport = *line->transport;
  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = reinterpret_cast<uint8_t *>(line->text);
  frame.len = line->length;
  for (int socket : transport.clientSockets_) {
    if (socket >= 0 &&
        httpd_ws_get_fd_info(transport.server_, socket) == HTTPD_WS_CLIENT_WEBSOCKET) {
      httpd_ws_send_frame_async(transport.server_, socket, &frame);
    }
  }
  free(line);
  transport.pendingOutbound_.fetch_sub(1);
}

bool WirelessTransport::startAccessPoint() {
  if (enabled_) {
    return true;
  }
  if (inboundQueue_ == nullptr) {
    inboundQueue_ = xQueueCreate(INBOUND_QUEUE_LENGTH, sizeof(InboundLine *));
    if (inboundQueue_ == nullptr) {
      return false;
    }
  }
  resetClientSockets();

  // Do not write the WiFi configuration to flash: flash writes stall both cores.
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  // The address of the contract, where the control panel looks for the console, is the gateway of
  // the clients too.
  const IPAddress address(ACCESS_POINT_ADDRESS[0], ACCESS_POINT_ADDRESS[1], ACCESS_POINT_ADDRESS[2],
                          ACCESS_POINT_ADDRESS[3]);
  if (!WiFi.softAPConfig(address, address, ACCESS_POINT_SUBNET_MASK) ||
      !WiFi.softAP(ssid_, J5_ACCESS_POINT_PASSWORD, ACCESS_POINT_CHANNEL, 0,
                   ACCESS_POINT_MAXIMUM_CLIENTS)) {
    WiFi.mode(WIFI_OFF);
    return false;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.core_id = 0;
  config.max_open_sockets = ACCESS_POINT_MAXIMUM_CLIENTS;
  config.lru_purge_enable = true;
  config.global_user_ctx = this;
  config.global_user_ctx_free_fn = keepGlobalContext;
  config.close_fn = closeSession;
  if (httpd_start(&server_, &config) != ESP_OK) {
    server_ = nullptr;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    return false;
  }

  httpd_uri_t consoleUri = {};
  consoleUri.uri = CONSOLE_WEBSOCKET_PATH;
  consoleUri.method = HTTP_GET;
  consoleUri.handler = handleConsole;
  consoleUri.user_ctx = this;
  consoleUri.is_websocket = true;
  consoleUri.handle_ws_control_frames = false;
  consoleUri.supported_subprotocol = nullptr;
  // Without the console URI the access point would offer nothing: it fails as a whole.
  if (httpd_register_uri_handler(server_, &consoleUri) != ESP_OK) {
    httpd_stop(server_);
    server_ = nullptr;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    return false;
  }

  enabled_ = true;
  return true;
}

void WirelessTransport::stopAccessPoint() {
  if (!enabled_) {
    return;
  }
  httpd_stop(server_);
  server_ = nullptr;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  resetClientSockets();
  enabled_ = false;
}

bool WirelessTransport::readLine(char *buffer, size_t capacity, bool &overflowed) {
  if (inboundQueue_ == nullptr) {
    return false;
  }
  InboundLine *line = nullptr;
  if (xQueueReceive(inboundQueue_, &line, 0) != pdTRUE) {
    return false;
  }
  strncpy(buffer, line->text, capacity - 1);
  buffer[capacity - 1] = '\0';
  overflowed = line->overflowed;
  free(line);
  return true;
}

bool WirelessTransport::writeLine(const char *line, size_t length) {
  if (!enabled_ || connectedClients_.load() == 0) {
    return true;
  }
  if (pendingOutbound_.load() >= MAXIMUM_PENDING_OUTBOUND) {
    return false;
  }
  OutboundLine *outbound = static_cast<OutboundLine *>(malloc(sizeof(OutboundLine) + length));
  if (outbound == nullptr) {
    return false;
  }
  outbound->transport = this;
  outbound->length = length;
  memcpy(outbound->text, line, length);
  outbound->text[length] = '\0';
  pendingOutbound_.fetch_add(1);
  if (httpd_queue_work(server_, sendOutboundLine, outbound) != ESP_OK) {
    pendingOutbound_.fetch_sub(1);
    free(outbound);
    return false;
  }
  return true;
}

} // namespace firmware
