#ifndef J5_PRESENCE_SERVICE_H
#define J5_PRESENCE_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../messages/hello_message.h"
#include "../network/frame.h"
#include "../network/neighbor_table.h"
#include "../network/transmit_queue.h"
#include "../protocol/protocol_contract.h"
#include "../radio/received_frame.h"
#include "test_run_service.h"

namespace firmware {

// Hears the HELLO of a neighbor once the presence service has recorded it and emitted its hello
// event, so that whatever the HELLO causes follows that event on the console.
class HelloListener {
public:
  virtual void onNeighborHello(uint16_t source, const AnnouncedState &announced,
                               uint32_t nowMillis) = 0;

protected:
  ~HelloListener() = default;
};

// The HELLO messages (docs/protocol/frame.md): the periodic one, every HELLO_PERIOD_MS with a
// random variation of +/- HELLO_JITTER_MS, the immediate one after a change of version, the
// operator hold with its expiry, and the HELLO messages of the neighbors, which it records in the
// neighbor table and passes on to its listener. It emits hello, neighbor and presence. It hears
// from the test runs when the last one ends. When a HELLO leaves, given the runs and the bursts,
// is the rule of NodeServices.
class PresenceService : public TestRunListener {
public:
  void begin(EventSink &events, NeighborTable &neighbors, HelloListener &listener,
             uint32_t nowMillis);

  // The operator holds the HELLO messages.
  bool isHeld() const { return held_; }

  void requestImmediate() { immediateRequested_ = true; }
  // A HELLO waits to announce a change at once.
  bool isImmediateRequested() const { return immediateRequested_; }
  bool isPeriodicHelloDue(uint32_t nowMillis) const;
  // Writes the body of the HELLO of the node, with the neighbors of the table, describes it and
  // schedules the next periodic one. Returns the body length.
  size_t buildHello(const AnnouncedState &announced, uint32_t nowMillis,
                    FrameDescription &description, uint8_t *payload);
  // When the last run ends, the next periodic HELLO follows in FIRST_HELLO_MINIMUM_DELAY_MS to
  // FIRST_HELLO_MAXIMUM_DELAY_MS, as at boot.
  void onRunsEnded(uint32_t nowMillis) override;

  // Hold requested by the operator ("presence off"): no HELLO until release() or until the hold
  // expires, so a hold left behind by a lost console does not silence the node for good. Both
  // emit presence.
  void hold(uint32_t durationMillis, uint32_t nowMillis);
  void release(uint32_t nowMillis);
  // Ends an expired hold, with a presence event.
  void poll(uint32_t nowMillis);
  void reportPresence(uint32_t nowMillis);
  // A neighbor event for each neighbor, as status asks for them.
  void reportNeighbors(uint32_t nowMillis);

  // A HELLO from a neighbor: records it in the neighbor table, emits hello and passes it on to
  // the listener.
  void handleHello(const FrameHeader &header, const HelloMessage &message,
                   const ReceivedFrame &frame, uint32_t nowMillis);

private:
  void endHold(uint32_t nowMillis);
  void scheduleResumption(uint32_t nowMillis);
  uint32_t holdRemainingMillis(uint32_t nowMillis) const;

  EventSink *events_ = nullptr;
  NeighborTable *neighbors_ = nullptr;
  HelloListener *listener_ = nullptr;
  uint32_t nextMillis_ = 0;
  bool immediateRequested_ = false;
  bool held_ = false;
  uint32_t holdStartMillis_ = 0;
  uint32_t holdDurationMillis_ = 0;
};

} // namespace firmware

#endif
