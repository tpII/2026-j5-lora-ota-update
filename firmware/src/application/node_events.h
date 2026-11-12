#ifndef J5_NODE_EVENTS_H
#define J5_NODE_EVENTS_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../network/frame.h"
#include "../network/transmit_queue.h"
#include "../protocol/protocol_contract.h"
#include "../radio/radio_settings.h"
#include "../radio/received_frame.h"

namespace firmware {

// The events that describe the node itself and its frames, which no service owns: boot, status,
// radio, wifi, tx, drop, duplicate and id_conflict (docs/protocol/console.md). They are written
// from plain values, so the host tests check them as they check the events of the services.

struct NodeCounters {
  uint32_t transmitted;
  uint32_t received;
  uint32_t droppedLines;
  uint32_t freeHeap;
};

void writeBootEvent(EventSink &events, uint16_t nodeId, BoardModel model, uint8_t epoch);
void writeStatusEvent(EventSink &events, uint16_t nodeId, BoardModel model, uint8_t epoch,
                      const NodeCounters &counters);
// lna is null on a board without a low noise amplifier.
void writeRadioEvent(EventSink &events, const RadioSettings &settings, int8_t transceiverPower,
                     BoardModel model);
void writeWifiEvent(EventSink &events, bool enabled, const char *ssid, uint8_t channel,
                    uint8_t clients);
// A frame of this node that ended its transmission, with its measured and calculated time on air.
void writeTransmissionEvent(EventSink &events, const FrameDescription &description, size_t length,
                            const TransmitTiming &timing);
void writeDropEvent(EventSink &events, DropReason reason, const ReceivedFrame &frame);
void writeDuplicateEvent(EventSink &events, const FrameHeader &header, MessageType type);
// A frame with the identifier of this node as source, followed by its debug text.
void writeIdConflictEvent(EventSink &events, const FrameHeader &header, const ReceivedFrame &frame);

// Writes the tx event of every frame whose transmission ends, before its owner hears it.
class TransmissionEventWriter : public TransmissionRecorder {
public:
  void begin(EventSink &events) { events_ = &events; }
  void recordTransmission(const QueuedFrame &frame, const TransmitTiming &timing) override {
    writeTransmissionEvent(*events_, frame.description, frame.length, timing);
  }

private:
  EventSink *events_ = nullptr;
};

} // namespace firmware

#endif
