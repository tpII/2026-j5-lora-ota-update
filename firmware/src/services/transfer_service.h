#ifndef J5_TRANSFER_SERVICE_H
#define J5_TRANSFER_SERVICE_H

#include <stddef.h>
#include <stdint.h>

#include "../console/console.h"
#include "../display/debug_display.h"
#include "../image/image_format.h"
#include "../image/image_verifier.h"
#include "../network/frame.h"
#include "../network/neighbor_table.h"
#include "../radio/radio_settings.h"
#include "../transfer/burst_scheduler.h"
#include "../transfer/image_reception.h"

namespace firmware {

enum class ActivationCause : uint8_t { Console, Hello, Neighbor };

// Name of the cause in the activation event ("console", "hello" or "neighbor").
const char *activationCauseName(ActivationCause cause);

struct ActivationRequest {
  ActivationCause cause;
  uint16_t source;
};

enum class ImageLoad : uint8_t { Accepted, Invalid, VersionNotNewer };

// Image transfer (docs/protocol/frame.md, "Transferencia de imágenes"): the available image, the
// reception in progress and the bursts. Images live only in RAM. The service emits the transfer
// events itself; the application gives it the frames it receives, asks it for the next report or
// fragment when the transmitter is free and HELLO messages are not suspended, and performs the
// activations and the immediate HELLO that the service requests.
class TransferService {
public:
  // Returns false when the operator public key is not valid; every image then fails.
  bool begin(Console &console, DebugDisplay &display, const NeighborTable &neighbors,
             const RadioSettings &settings);

  uint32_t availableVersion() const { return availableVersion_; }
  const uint8_t *availableProgram() const { return availableImage_ + IMAGE_HEADER_SIZE; }
  size_t availableProgramLength() const { return availableHeader_.programLength; }

  // load_image: the image as two hexadecimal digits per byte. On Invalid and VersionNotNewer the
  // detail buffer explains the error.
  ImageLoad loadImage(const char *hexadecimal, char *detail, size_t detailCapacity);
  uint8_t fragmentSize() const { return fragmentSize_; }
  void setFragmentSize(uint8_t size) { fragmentSize_ = size; }
  void emitTransfer(uint32_t activeVersion);

  // Received frames whose bodies the application has already validated.
  void handleFragment(uint16_t source, const uint8_t *payload, size_t length, float rssi, float snr,
                      uint32_t nowMillis);
  // Only reports addressed to this node.
  void handleReport(uint16_t source, const uint8_t *payload, size_t length);
  void handleHello(uint16_t source, uint32_t activeVersion, uint32_t availableVersion,
                   uint32_t ownActiveVersion);

  // The node sends or receives a burst: the periodic HELLO waits.
  bool isBurstInProgress(uint32_t nowMillis) const;
  // Writes the next report or fragment, if one is due, and returns its body length (0 if none).
  size_t buildNextFrame(uint32_t nowMillis, MessageType &type, uint16_t &destination,
                        uint8_t *payload);
  void onFragmentStarted(int64_t startMicros);
  void onFragmentSent(uint32_t version, int64_t endMicros);
  void onFragmentFailed(uint32_t version);

  // True once after the available version changes: the node sends a HELLO at once.
  bool takeVersionChange();
  // True once for each activation that the received frames call for.
  bool takeActivationRequest(ActivationRequest &request);

private:
  void installImage(const uint8_t *image, size_t length, const ImageHeader &header, bool viaRadio,
                    uint32_t nowMillis);
  void completeReception(uint32_t nowMillis);
  void requestActivation(ActivationCause cause, uint16_t source);
  uint32_t fragmentAirMillis(uint8_t size) const;
  uint32_t reportAirMillis(uint8_t count) const;
  void emitBurstDone();
  void emitReport(const char *name, const char *peerKey, uint16_t peer, const ReportFields &report,
                  int round);
  void debug(const char *format, ...);

  Console *console_ = nullptr;
  DebugDisplay *display_ = nullptr;
  const NeighborTable *neighbors_ = nullptr;
  const RadioSettings *settings_ = nullptr;
  ImageVerifier verifier_;
  ImageReception reception_;
  BurstScheduler bursts_;

  uint8_t availableImage_[MAXIMUM_IMAGE_SIZE] = {};
  size_t availableLength_ = 0;
  uint32_t availableVersion_ = 0;
  ImageHeader availableHeader_ = {};
  uint8_t fragmentSize_ = DEFAULT_FRAGMENT_SIZE;

  bool versionChanged_ = false;
  bool activationRequested_ = false;
  ActivationRequest activation_ = {};
};

} // namespace firmware

#endif
