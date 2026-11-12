#ifndef J5_NODE_SERVICES_H
#define J5_NODE_SERVICES_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../messages/echo_message.h"
#include "../messages/hello_message.h"
#include "../network/duplicate_filter.h"
#include "../network/frame.h"
#include "../network/neighbor_table.h"
#include "../network/transmit_queue.h"
#include "../radio/radio_settings.h"
#include "../radio/received_frame.h"
#include "../services/activation_controller.h"
#include "../services/echo_service.h"
#include "../services/presence_service.h"
#include "../services/test_run_service.h"
#include "../services/transfer_service.h"
#include "node_events.h"

namespace firmware {

// The modules of the node that need no hardware, connected as the node runs them, and the protocol
// policy that spans them: what the node transmits next and what it does with each frame it
// receives. A HELLO from a neighbor goes through presence to the transfer, the transfer tells the
// activation when the available version changes and when a neighbor runs it, the activation and
// the end of the test runs reach presence, and the queue tells each owner how its frames went and
// writes the tx event of every frame first. NodeApplication owns one and gives it the radio; the
// host tests connect several through a medium of their own, so every chain and every rule runs in
// the tests as on the node.
class NodeServices {
public:
  NeighborTable neighbors;
  TransmitQueue queue;
  TransmissionEventWriter transmissions;
  PresenceService presence;
  EchoService echo;
  TestRunService runs;
  TransferService transfer;
  ActivationController activation;

  // Starts every service and connects them. nodeId and model are those of the node, and sequences
  // numbers its frames. The first HELLO waits from nowMillis. Returns false when the operator
  // public key is not valid.
  bool begin(EventSink &events, uint16_t nodeId, BoardModel model, SequenceSource &sequences,
             uint32_t nowMillis);
  uint16_t nodeId() const { return nodeId_; }
  BoardModel model() const { return model_; }

  // While suspended, no HELLO, fragment or report leaves the node: during a test run, whether the
  // node sends it or receives it, and during a hold.
  bool isSuspended() const { return runs.isActive() || presence.isHeld(); }
  // When the node is not suspended: the immediate HELLO, or else the periodic one unless a burst
  // postpones it.
  bool isHelloDue(uint32_t nowMillis) const;
  AnnouncedState announcedState() const;

  // Transmission. Whenever the transmitter is free and the queue is empty, the node queues the
  // frame that is due, in this order: a TEST frame, the HELLO, and a report or a fragment only
  // while the HELLO messages are not suspended. Returns the frame to transmit next, or nullptr.
  const QueuedFrame *nextFrame(uint32_t nowMillis, const RadioSettings &settings);
  // The radio started the frame of nextFrame() at startMicros, with the settings.
  void recordTransmitStart(uint32_t nowMillis, int64_t startMicros, const RadioSettings &settings);
  // The radio refused the frame of nextFrame().
  void recordTransmitFailure() { queue.failNext(); }
  // The frame on the air ended at endMicros, as the pass at nowMillis saw.
  void recordTransmitEnd(int64_t endMicros, uint32_t nowMillis) {
    queue.completeInFlight(endMicros, nowMillis);
  }

  // The timers of the services: the deadline of an echo, the ends of the runs, the expiry of a
  // hold and the ticks of the VM.
  void poll(uint32_t nowMillis);

  // The echo command: queues a request to the node. Returns false when the queue is full.
  bool requestEcho(uint16_t destination, uint16_t size);

  // Reception (docs/protocol/frame.md, "Recepción"): checks the frame in the order of the
  // contract and drops it with its event at the first check it fails, records its source as a
  // neighbor and, when it is addressed to this node or to every node, hands it to its service. The
  // settings are those of the radio that received it.
  void receive(const ReceivedFrame &frame, uint32_t nowMillis, const RadioSettings &settings);
  // Frames that passed every check since the boot, those addressed to other nodes included.
  uint32_t receivedCount() const { return receivedCount_; }

private:
  // Encodes and queues a message. The header comes from the description, which gets the sequence;
  // a full queue refuses the frame before it takes a sequence number.
  bool enqueueMessage(FrameOwner owner, FrameDescription description, const uint8_t *payload,
                      size_t payloadLength, bool priority);
  void enqueueHello(uint32_t nowMillis);
  void enqueueEchoReply(const FrameHeader &header, const EchoRequestMessage &request,
                        const ReceivedFrame &frame);
  void enqueueTestFrame();
  void enqueueTransferFrame(uint32_t nowMillis, const RadioSettings &settings);

  EventSink *events_ = nullptr;
  uint16_t nodeId_ = NO_NODE_ID;
  BoardModel model_ = BoardModel::HeltecV2;
  SequenceSource *sequences_ = nullptr;
  DuplicateFilter duplicates_;
  uint32_t receivedCount_ = 0;
};

} // namespace firmware

#endif
