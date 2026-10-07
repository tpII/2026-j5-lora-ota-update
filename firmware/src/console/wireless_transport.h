#ifndef J5_WIRELESS_TRANSPORT_H
#define J5_WIRELESS_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

namespace j5 {

// Console over the node's own WiFi access point: a WebSocket at ws://192.168.4.1/console that
// carries one console line per text message
// (docs/adrs/0003-control-panel-as-pwa-over-websocket.md). The ESP-IDF HTTP server runs in its own
// task on core 0. Its handlers only move lines through bounded queues; every decision stays in the
// main loop.
class WirelessTransport {
public:
  bool begin(const char *ssid, const char *password, uint8_t channel, uint8_t maximumClients);
  void end();

  bool isEnabled() const { return enabled_; }
  uint8_t clientCount() const;
  uint8_t channel() const { return channel_; }

  // Returns true when a command line from a client is available.
  bool readLine(char *buffer, size_t capacity, bool &overflowed);

  // Sends the line to every connected client. Returns false when the line was dropped.
  bool writeLine(const char *line, size_t length);

  // True once after each client connection or disconnection.
  bool takeClientChange();

private:
  bool enabled_ = false;
  uint8_t channel_ = 0;
};

} // namespace j5

#endif
