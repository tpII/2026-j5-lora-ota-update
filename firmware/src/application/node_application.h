#ifndef J5_NODE_APPLICATION_H
#define J5_NODE_APPLICATION_H

#include <SimpleCLI.h>
#include <stddef.h>
#include <stdint.h>

#include "../board/board_support.h"
#include "../console/console.h"
#include "../console/serial_transport.h"
#include "../console/wireless_transport.h"
#include "../display/debug_display.h"
#include "../network/duplicate_filter.h"
#include "../network/frame.h"
#include "../network/neighbor_table.h"
#include "../network/node_identity.h"
#include "../radio/radio_link.h"
#include "../radio/radio_settings.h"
#include "../services/echo_service.h"
#include "../services/presence_service.h"
#include "../services/test_run_service.h"

namespace firmware {

// The node: a single main loop that serves the radio first, then the transmission queue, the
// console, the timers and finally the display.
class NodeApplication {
public:
  void begin();
  void poll();

private:
  struct OutgoingFrame {
    uint8_t data[MAXIMUM_FRAME_SIZE];
    size_t length;
  };

  struct EchoReplyRecord {
    bool pending;
    uint16_t source;
    uint16_t number;
    uint16_t size;
    float rssi;
    float snr;
  };

  // Radio.
  void serviceRadio(uint32_t nowMillis);
  void serviceTransmitter(uint32_t nowMillis);
  void onTransmitStarted(uint32_t nowMillis);
  void onTransmitDone(uint32_t nowMillis);
  void onFrameReceived(const ReceivedFrame &frame, uint32_t nowMillis);
  bool isPayloadValid(uint8_t type, const uint8_t *payload, size_t length) const;
  void handleHello(const FrameHeader &header, const uint8_t *payload, size_t length,
                   const ReceivedFrame &frame);
  void handleEchoRequest(const FrameHeader &header, const uint8_t *payload, size_t length,
                         const ReceivedFrame &frame);
  void handleEchoReply(const FrameHeader &header, const uint8_t *payload, size_t length,
                       const ReceivedFrame &frame);
  void handleTestFrame(const FrameHeader &header, const uint8_t *payload, size_t length,
                       const ReceivedFrame &frame, uint32_t nowMillis);

  // Transmission queue.
  bool enqueueFrame(MessageType type, uint16_t destination, const uint8_t *payload,
                    size_t payloadLength, bool priority);
  bool enqueueRawFrame(const uint8_t *data, size_t length, bool priority);
  OutgoingFrame *reserveQueueSlot(bool priority);
  void enqueueHello();
  void enqueueTestFrame();

  // Console.
  void registerCommands();
  void serviceConsole();
  void executeCommand(const char *line);
  void reportCommandError(const CommandError &error, const char *line);
  void commandHelp();
  void commandStatus();
  void commandRadio(const Command &command);
  void commandEcho(const Command &command);
  void commandRun(const Command &command);
  void commandWifi(const Command &command);
  void commandResend();
  void commandPresence(const Command &command);
  bool isRunActive() const;
  void requestRadioSettings(const RadioSettings &settings);
  void applyRadioSettings(const RadioSettings &settings);

  // Timers.
  void serviceTimers(uint32_t nowMillis);
  void finishSenderRun(bool aborted);
  void finishReceiverRun(ReceiverRun &run, const char *reason);
  void updateSuspension(uint32_t nowMillis);

  // Events and debug text.
  void emitBoot();
  void emitRadio();
  void emitWifi();
  void emitPresence(uint32_t nowMillis);
  void emitError(const char *command, const char *reason, const char *detail = nullptr,
                 int16_t code = 0);
  void emitDrop(const char *reason, const ReceivedFrame &frame);
  void debug(const char *format, ...);
  void updateStatusLine();

  BoardSupport board_;
  NodeIdentity identity_;
  RadioLink radio_;
  DuplicateFilter duplicates_;
  NeighborTable neighbors_;
  PresenceService presence_;
  EchoService echo_;
  TestRunService runs_;
  SerialTransport serial_;
  WirelessTransport wireless_;
  Console console_;
  DebugDisplay display_;

  SimpleCLI commandInterpreter_;
  Command helpCommand_;
  Command statusCommand_;
  Command radioCommand_;
  Command echoCommand_;
  Command runCommand_;
  Command wifiCommand_;
  Command resendCommand_;
  Command presenceCommand_;

  OutgoingFrame queue_[TRANSMIT_QUEUE_CAPACITY] = {};
  size_t queueHead_ = 0;
  size_t queueCount_ = 0;
  OutgoingFrame inFlight_ = {};
  bool hasInFlight_ = false;
  OutgoingFrame lastTransmitted_ = {};
  bool hasLastTransmitted_ = false;
  RadioSettings pendingSettings_ = {};
  bool hasPendingSettings_ = false;
  EchoReplyRecord echoReply_ = {};
  ReceivedFrame receivedFrame_ = {};

  bool radioReady_ = false;
  uint32_t transmittedCount_ = 0;
  uint32_t receivedCount_ = 0;
  uint16_t echoCounter_ = 0;
  uint32_t lastExpiryMillis_ = 0;
  char accessPointName_[12] = {};
};

} // namespace firmware

#endif
