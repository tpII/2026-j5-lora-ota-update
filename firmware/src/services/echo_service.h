#ifndef J5_ECHO_SERVICE_H
#define J5_ECHO_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../messages/echo_message.h"
#include "../network/frame.h"
#include "../network/transmit_queue.h"
#include "../radio/received_frame.h"

namespace firmware {

// The echo (docs/protocol/frame.md): the one outstanding request of this node, with its deadline,
// and the replies to the requests of other nodes. It hears the transmissions of its requests and
// of its replies as FrameOwner::Echo, and emits echo, echo_lost and echo_served.
class EchoService : public TransmitListener {
public:
  void begin(EventSink &events) { events_ = &events; }

  bool isPending() const { return pending_; }

  // Writes the body of a request to the node and describes it. The request waits for its reply
  // from the moment it starts transmitting; until then nothing expires, and if the queue refuses
  // it, the service hears that it failed and forgets it.
  size_t buildRequest(uint16_t destination, uint16_t size, FrameDescription &description,
                      uint8_t *payload);
  // Writes the body of the reply to a request of another node, with how the request arrived, and
  // describes it. The service keeps the reply for echo_served until the queue tells how it went.
  size_t buildReply(const FrameHeader &header, const EchoRequestMessage &request,
                    const ReceivedFrame &frame, FrameDescription &description, uint8_t *payload);

  // A request starts its deadline, echoLossDeadlineMillis(), once it is on the air; a reply emits
  // echo_served then.
  void onTransmitStarted(const FrameDescription &frame, const TransmitTiming &timing) override;
  void onTransmitFailed(const FrameDescription &frame) override;

  // A reply to this node: emits echo when it answers the outstanding request.
  void handleReply(const FrameHeader &header, const EchoReplyMessage &reply,
                   const ReceivedFrame &frame);
  // Emits echo_lost when the deadline of the outstanding request has passed.
  void poll(uint32_t nowMillis);

private:
  // A reply that is built and not on the air yet. Its slot is the tag of its frame.
  struct PendingReply {
    bool used;
    EchoReplyMessage reply;
  };
  // Every reply that the queue can hold, and the one that it is refusing.
  static constexpr size_t MAXIMUM_PENDING_REPLIES = TRANSMIT_QUEUE_CAPACITY + 1;

  EventSink *events_ = nullptr;
  PendingReply replies_[MAXIMUM_PENDING_REPLIES] = {};
  uint16_t requestCounter_ = 0;
  bool pending_ = false;
  bool transmitting_ = false;
  uint16_t destination_ = 0;
  uint16_t number_ = 0;
  uint16_t size_ = 0;
  int64_t startMicros_ = 0;
  uint32_t startMillis_ = 0;
  uint32_t timeoutMillis_ = 0;
};

} // namespace firmware

#endif
