#ifndef J5_TRANSFER_SERVICE_H
#define J5_TRANSFER_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../console/event_sink.h"
#include "../image/image_format.h"
#include "../image/image_verifier.h"
#include "../network/frame.h"
#include "../network/neighbor_table.h"
#include "../network/transmit_queue.h"
#include "../protocol/protocol_contract.h"
#include "../radio/radio_settings.h"
#include "../transfer/burst_scheduler.h"
#include "../transfer/image_reception.h"
#include "../vm/virtual_machine.h"
#include "presence_service.h"

namespace firmware {

// Hears what the transfer asks of the rest of the node.
class TransferListener {
public:
  // The active version, which the transfer event reports beside the available one.
  virtual uint32_t activeVersion() const = 0;
  // The available version changed: the node announces it with a HELLO at once.
  virtual void onAvailableVersionChanged() = 0;
  // A neighbor runs the available version, so the node activates it if it is newer than the
  // active one (docs/adrs/0011-implicit-activation-without-rollback.md).
  virtual void onActivationWanted(ActivationCause cause, uint16_t source, uint32_t nowMillis) = 0;

protected:
  ~TransferListener() = default;
};

enum class ImageLoad : uint8_t { Accepted, Invalid, VersionNotNewer };

// Image transfer (docs/protocol/frame.md, "Transferencia de imágenes"): the available image, the
// reception in progress and the bursts. Images live only in RAM. The service emits the transfer
// events; the application gives it the frames it receives and asks it for the next report or
// fragment when the transmitter is free and HELLO messages are not suspended. It tells its
// listener when the available version changes and when a neighbor runs it, hears the HELLO
// messages of the neighbors from the presence service and the transmissions of its frames as
// FrameOwner::Transfer. The time on air of its frames comes from the radio settings that each call
// passes.
class TransferService : public TransmitListener, public HelloListener {
public:
  // Returns false when the operator public key is not valid; every image then fails. nodeId is
  // the identifier of this node, the only destination of the reports it takes.
  bool begin(EventSink &events, NeighborTable &neighbors, TransferListener &listener,
             uint16_t nodeId);

  uint32_t availableVersion() const { return availableVersion_; }
  // The program of the available image, empty while there is none.
  const ValidProgram &availableProgram() const { return availableProgram_; }

  // load_image: the image as two hexadecimal digits per byte. On Invalid and VersionNotNewer the
  // detail buffer explains the error.
  ImageLoad loadImage(const char *hexadecimal, char *detail, size_t detailCapacity);
  void setFragmentSize(uint8_t size) { fragmentSize_ = size; }
  // The transfer event, with the active version of the listener.
  void reportTransfer();

  void handleFragment(uint16_t source, const FragmentMessage &fragment, float rssi, float snr,
                      const RadioSettings &settings, uint32_t nowMillis);
  // A report goes to the node that sent the last fragment: one addressed to every node is ignored.
  void handleReport(const FrameHeader &header, const ReportMessage &report);
  void onNeighborHello(uint16_t source, const AnnouncedState &announced,
                       uint32_t nowMillis) override;

  // The node sends or receives a burst: the periodic HELLO waits.
  bool isBurstInProgress(uint32_t nowMillis) const;
  // Writes and describes the next report or fragment, if one is due, and returns its body length
  // (0 if none).
  size_t buildNextFrame(uint32_t nowMillis, const RadioSettings &settings,
                        FrameDescription &description, uint8_t *payload);
  void onTransmitStarted(const FrameDescription &frame, const TransmitTiming &timing) override;
  void onTransmitDone(const FrameDescription &frame, const TransmitTiming &timing) override;
  void onTransmitFailed(const FrameDescription &frame) override;

private:
  void installImage(const uint8_t *image, size_t length, const ImageHeader &header,
                    const ValidProgram &program, ImageArrival arrival, uint32_t nowMillis);
  void completeReception(uint32_t nowMillis);
  void emitBurstStart(const BurstSummary &burst);
  void emitBurstDone(const BurstSummary &burst);
  // report_sent carries the round of the reception, which the node that receives it does not know.
  void emitReportSent(const ReportMessage &report);
  void emitReportReceived(uint16_t source, const ReportMessage &report);

  EventSink *events_ = nullptr;
  NeighborTable *neighbors_ = nullptr;
  TransferListener *listener_ = nullptr;
  uint16_t nodeId_ = NO_NODE_ID;
  ImageVerifier verifier_;
  ImageReception reception_;
  BurstScheduler bursts_;

  uint8_t availableImage_[MAXIMUM_IMAGE_SIZE] = {};
  size_t availableLength_ = 0;
  uint32_t availableVersion_ = 0;
  ValidProgram availableProgram_;
  uint8_t fragmentSize_ = DEFAULT_FRAGMENT_SIZE;
};

} // namespace firmware

#endif
