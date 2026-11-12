#ifndef J5_WIRELESS_TRANSPORT_H
#define J5_WIRELESS_TRANSPORT_H

#include <atomic>
#include <esp_http_server.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <stddef.h>
#include <stdint.h>

#include "../protocol/protocol_contract.h"

namespace firmware {

constexpr uint8_t ACCESS_POINT_CHANNEL = 1;
constexpr uint8_t ACCESS_POINT_MAXIMUM_CLIENTS = 4;

// What changed in the access point since the last takeStateChange().
enum class WirelessChange : uint8_t {
  None,
  Clients,  // a client connected or disconnected
  Switched, // the operator turned the access point on or off, or tried to
};

// Console over the node's own WiFi access point, named after the node (ACCESS_POINT_NAME_FORMAT):
// a WebSocket at CONSOLE_WEBSOCKET_PATH that carries one console line per text message
// (docs/adrs/0002-wifi-access-point-per-node.md and
// docs/adrs/0003-control-panel-as-pwa-over-websocket.md). The ESP-IDF HTTP server runs in its own
// task on core 0. Its handlers only move lines through bounded queues; every decision stays in the
// main loop.
class WirelessTransport {
public:
  // Names the access point after the node and starts it. The boot reports that state with its own
  // events, so it is no change. Returns false when the access point did not start.
  bool begin(uint16_t nodeId);
  // Turn the access point on or off at the request of the operator. Each call is a Switched
  // change, even when the state stays the same, so that the operator always gets an answer.
  // start() returns false when the access point did not start.
  bool start();
  void stop();

  bool isEnabled() const { return enabled_; }
  const char *ssid() const { return ssid_; }
  uint8_t channel() const { return ACCESS_POINT_CHANNEL; }
  uint8_t clientCount() const { return connectedClients_.load(); }
  // The change since the last call, Switched before Clients, and None after it is taken.
  WirelessChange takeStateChange();

  // Returns true when a command line from a client is available.
  bool readLine(char *buffer, size_t capacity, bool &overflowed);

  // Sends the line to every connected client. Returns false when the line was dropped.
  bool writeLine(const char *line, size_t length);

private:
  bool startAccessPoint();
  void stopAccessPoint();
  void resetClientSockets();
  void addClient(int socket);
  void removeClient(int socket);
  void noteClientChange();

  // Callbacks of the HTTP server task.
  static esp_err_t handleConsole(httpd_req_t *request);
  static void closeSession(httpd_handle_t handle, int socket);
  static void sendOutboundLine(void *argument);
  static void keepGlobalContext(void *context);

  char ssid_[ACCESS_POINT_NAME_LENGTH + 1] = {};
  bool enabled_ = false;
  httpd_handle_t server_ = nullptr;
  QueueHandle_t inboundQueue_ = nullptr;
  // Client sockets are only touched from the HTTP server task.
  int clientSockets_[ACCESS_POINT_MAXIMUM_CLIENTS] = {};
  std::atomic<uint8_t> connectedClients_{0};
  std::atomic<uint8_t> change_{static_cast<uint8_t>(WirelessChange::None)};
  std::atomic<uint16_t> pendingOutbound_{0};
};

} // namespace firmware

#endif
