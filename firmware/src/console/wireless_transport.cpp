#include "wireless_transport.h"

#include <WiFi.h>
#include <atomic>
#include <esp_http_server.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "../configuration.h"

namespace firmware {

static constexpr size_t INBOUND_QUEUE_LENGTH = 8;
static constexpr uint16_t MAXIMUM_PENDING_OUTBOUND = 32;
static constexpr size_t MAXIMUM_DISCARDED_FRAME_SIZE = 4096;

namespace {

struct InboundLine {
  char text[CONSOLE_LINE_CAPACITY + 1];
  bool overflowed;
};

struct OutboundLine {
  size_t length;
  char text[1];
};

} // namespace

static httpd_handle_t server = nullptr;
static QueueHandle_t inboundQueue = nullptr;

// Client sockets are only touched from the HTTP server task.
static int clientSockets[ACCESS_POINT_MAXIMUM_CLIENTS];
static std::atomic<uint8_t> connectedClients{0};
static std::atomic<bool> clientChanged{false};
static std::atomic<uint16_t> pendingOutbound{0};

static void resetClientSockets() {
  for (int &socket : clientSockets) {
    socket = -1;
  }
}

static void addClient(int socket) {
  for (int &slot : clientSockets) {
    if (slot == socket) {
      return;
    }
  }
  for (int &slot : clientSockets) {
    if (slot < 0) {
      slot = socket;
      connectedClients.fetch_add(1);
      clientChanged.store(true);
      return;
    }
  }
}

static void removeClient(int socket) {
  for (int &slot : clientSockets) {
    if (slot == socket) {
      slot = -1;
      connectedClients.fetch_sub(1);
      clientChanged.store(true);
      return;
    }
  }
}

static void closeSession(httpd_handle_t handle, int socket) {
  (void)handle;
  removeClient(socket);
  close(socket);
}

static void trimLineEnd(char *text) {
  size_t length = strlen(text);
  while (length > 0 && (text[length - 1] == '\n' || text[length - 1] == '\r')) {
    text[--length] = '\0';
  }
}

static esp_err_t handleConsole(httpd_req_t *request) {
  // ESP-IDF 5.5.5, the base of core 3.3.12, completes the handshake without calling this handler,
  // so a client is registered when its first message arrives; the control panel sends status as
  // soon as the socket opens. Earlier releases also call it once with the handshake request.
  addClient(httpd_req_to_sockfd(request));
  if (request->method == HTTP_GET) {
    return ESP_OK;
  }

  httpd_ws_frame_t frame = {};
  esp_err_t result = httpd_ws_recv_frame(request, &frame, 0);
  if (result != ESP_OK) {
    return result;
  }

  InboundLine line = {};
  if (frame.type != HTTPD_WS_TYPE_TEXT || frame.len > CONSOLE_LINE_CAPACITY) {
    if (frame.len > MAXIMUM_DISCARDED_FRAME_SIZE) {
      return ESP_FAIL;
    }
    // Read and discard the message so the connection stays in step.
    uint8_t *discarded = static_cast<uint8_t *>(malloc(frame.len + 1));
    if (discarded == nullptr) {
      return ESP_ERR_NO_MEM;
    }
    frame.payload = discarded;
    result = frame.len > 0 ? httpd_ws_recv_frame(request, &frame, frame.len) : ESP_OK;
    free(discarded);
    if (result != ESP_OK || frame.type != HTTPD_WS_TYPE_TEXT) {
      return result;
    }
    line.overflowed = true;
  } else {
    frame.payload = reinterpret_cast<uint8_t *>(line.text);
    if (frame.len > 0) {
      result = httpd_ws_recv_frame(request, &frame, frame.len);
      if (result != ESP_OK) {
        return result;
      }
    }
    line.text[frame.len] = '\0';
    trimLineEnd(line.text);
  }

  // A full queue drops the command; the operator sees no reply and can repeat it.
  xQueueSend(inboundQueue, &line, 0);
  return ESP_OK;
}

static void sendOutboundLine(void *argument) {
  OutboundLine *line = static_cast<OutboundLine *>(argument);
  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_TEXT;
  frame.payload = reinterpret_cast<uint8_t *>(line->text);
  frame.len = line->length;
  for (int socket : clientSockets) {
    if (socket >= 0 && httpd_ws_get_fd_info(server, socket) == HTTPD_WS_CLIENT_WEBSOCKET) {
      httpd_ws_send_frame_async(server, socket, &frame);
    }
  }
  free(line);
  pendingOutbound.fetch_sub(1);
}

bool WirelessTransport::begin(const char *ssid, const char *password, uint8_t channel,
                              uint8_t maximumClients) {
  if (enabled_) {
    return true;
  }
  if (inboundQueue == nullptr) {
    inboundQueue = xQueueCreate(INBOUND_QUEUE_LENGTH, sizeof(InboundLine));
    if (inboundQueue == nullptr) {
      return false;
    }
  }
  resetClientSockets();
  connectedClients.store(0);

  // Do not write the WiFi configuration to flash: flash writes stall both cores.
  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(ssid, password, channel, 0, maximumClients)) {
    WiFi.mode(WIFI_OFF);
    return false;
  }

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.core_id = 0;
  config.max_open_sockets = maximumClients;
  config.lru_purge_enable = true;
  config.close_fn = closeSession;
  if (httpd_start(&server, &config) != ESP_OK) {
    server = nullptr;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);
    return false;
  }

  httpd_uri_t consoleUri = {};
  consoleUri.uri = "/console";
  consoleUri.method = HTTP_GET;
  consoleUri.handler = handleConsole;
  consoleUri.user_ctx = nullptr;
  consoleUri.is_websocket = true;
  consoleUri.handle_ws_control_frames = false;
  consoleUri.supported_subprotocol = nullptr;
  httpd_register_uri_handler(server, &consoleUri);

  enabled_ = true;
  channel_ = channel;
  clientChanged.store(true);
  return true;
}

void WirelessTransport::end() {
  if (!enabled_) {
    return;
  }
  httpd_stop(server);
  server = nullptr;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);
  resetClientSockets();
  connectedClients.store(0);
  enabled_ = false;
  clientChanged.store(true);
}

uint8_t WirelessTransport::clientCount() const { return connectedClients.load(); }

bool WirelessTransport::readLine(char *buffer, size_t capacity, bool &overflowed) {
  if (inboundQueue == nullptr) {
    return false;
  }
  InboundLine line;
  if (xQueueReceive(inboundQueue, &line, 0) != pdTRUE) {
    return false;
  }
  strncpy(buffer, line.text, capacity - 1);
  buffer[capacity - 1] = '\0';
  overflowed = line.overflowed;
  return true;
}

bool WirelessTransport::writeLine(const char *line, size_t length) {
  if (!enabled_ || connectedClients.load() == 0) {
    return true;
  }
  if (pendingOutbound.load() >= MAXIMUM_PENDING_OUTBOUND) {
    return false;
  }
  OutboundLine *outbound = static_cast<OutboundLine *>(malloc(sizeof(OutboundLine) + length));
  if (outbound == nullptr) {
    return false;
  }
  outbound->length = length;
  memcpy(outbound->text, line, length);
  outbound->text[length] = '\0';
  pendingOutbound.fetch_add(1);
  if (httpd_queue_work(server, sendOutboundLine, outbound) != ESP_OK) {
    pendingOutbound.fetch_sub(1);
    free(outbound);
    return false;
  }
  return true;
}

bool WirelessTransport::takeClientChange() { return clientChanged.exchange(false); }

} // namespace firmware
