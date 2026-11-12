#ifndef J5_TEST_RUN_SERVICE_H
#define J5_TEST_RUN_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../messages/test_message.h"
#include "../network/frame.h"
#include "../network/transmit_queue.h"
#include "../protocol/protocol_contract.h"
#include "../radio/radio_settings.h"
#include "../radio/received_frame.h"
#include "../timing/transmission_span.h"

namespace firmware {

// Runs from different sources that a receiver follows at once.
constexpr size_t MAXIMUM_RECEIVER_RUNS = 4;

// Hears when the node stops sending and receiving test runs: the last run that was going on, of
// either side, has ended.
class TestRunListener {
public:
  virtual void onRunsEnded(uint32_t nowMillis) = 0;

protected:
  ~TestRunListener() = default;
};

// Test runs (docs/protocol/frame.md): the sender transmits numbered TEST frames, one at a time, and
// hears their transmissions as FrameOwner::TestRun; receivers keep the statistics of each run they
// hear. It decides when each run ends, emits run_start, run_done, test_rx and run_end, and tells
// its listener when no run is left.
class TestRunService : public TransmitListener {
public:
  void begin(EventSink &events, TestRunListener &listener) {
    events_ = &events;
    listener_ = &listener;
  }

  bool isActive() const { return isSending() || isReceiving(); }

  // Sender side.
  bool isSending() const { return sender_.active; }
  void startSending(uint16_t count, uint16_t size, uint16_t interval, uint32_t nowMillis);
  // The run ends as soon as no frame of it is on the air.
  void requestStop();
  bool isFrameDue(uint32_t nowMillis) const;
  // Writes the body of the next frame, describes it and reserves it as the frame in flight.
  size_t buildNextFrame(FrameDescription &description, uint8_t *payload);
  void onTransmitStarted(const FrameDescription &frame, const TransmitTiming &timing) override;
  // The last frame of the run ends the run here.
  void onTransmitDone(const FrameDescription &frame, const TransmitTiming &timing) override;
  // A frame that does not go out ends the run at the next poll().
  void onTransmitFailed(const FrameDescription &frame) override;

  // Receiver side. A TEST frame from a neighbor: emits test_rx and updates the statistics of its
  // run, which it opens on its first frame and ends with run_end on its last one. A new run from
  // the same source ends the previous one. The time on air of the frame, with the settings of
  // the radio, sets how long the run waits for the next frame.
  void handleTestFrame(const FrameHeader &header, const TestMessage &message,
                       const ReceivedFrame &frame, const RadioSettings &settings,
                       uint32_t nowMillis);

  // Ends the runs of the receiver that waited too long for a frame and the run of the sender once
  // it is stopped or failed.
  void poll(uint32_t nowMillis);

private:
  // How a run of the sender goes on: until it sends every frame, the operator stops it or a frame
  // cannot go out.
  enum class SenderOutcome : uint8_t { InProgress, Stopped, Failed };

  struct SenderRun {
    bool active;
    SenderOutcome outcome;
    bool frameInFlight;
    uint16_t run;
    uint16_t count;
    uint16_t size;
    uint16_t interval;
    TransmissionSpan span;
    uint32_t nextTransmitMillis;
  };

  struct ReceiverRun {
    bool active;
    uint16_t source;
    uint16_t run;
    uint16_t count;
    uint16_t received;
    float rssiSum;
    float rssiMinimum;
    float rssiMaximum;
    float snrSum;
    uint32_t firstMillis;
    uint32_t lastMillis;
    uint32_t deadlineMillis;
  };

  // Tells the listener when the runs that were going on before a call have all ended.
  void notifyIfEnded(bool wasActive, uint32_t nowMillis);
  bool isReceiving() const;
  void finishSendingIfOver();
  void finishReceiving(ReceiverRun &run, RunEndReason reason);
  ReceiverRun *findActiveRun(uint16_t source);
  ReceiverRun *openRun(uint16_t source, const TestMessage &message, float rssi, uint32_t nowMillis);

  EventSink *events_ = nullptr;
  TestRunListener *listener_ = nullptr;
  SenderRun sender_ = {};
  uint16_t nextRunNumber_ = 1;
  ReceiverRun receivers_[MAXIMUM_RECEIVER_RUNS] = {};
};

} // namespace firmware

#endif
