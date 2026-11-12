#include "transfer_service.h"

#include <stdio.h>
#include <string.h>

#include "../configuration.h"
#include "../encoding/hex_codec.h"
#include "../radio/time_on_air.h"

namespace firmware {

static_assert(sizeof(J5_OPERATOR_PUBLIC_KEY) == 2 * OPERATOR_PUBLIC_KEY_SIZE + 1,
              "J5_OPERATOR_PUBLIC_KEY must hold two hexadecimal digits per key byte");

// The image of a load_image command, decoded before it is verified, so that a rejected image
// leaves the available one untouched.
static uint8_t consoleImage[MAXIMUM_IMAGE_SIZE];

static uint32_t fragmentAirMillis(uint8_t size, const RadioSettings &settings) {
  return roundUpToMillis(computeTimeOnAirMicros(fragmentFrameLength(size), settings));
}

static uint32_t reportAirMillis(uint8_t count, const RadioSettings &settings) {
  return roundUpToMillis(computeTimeOnAirMicros(reportFrameLength(count), settings));
}

// The fields that report_sent and report_received share, after the node at the other end.
static void writeReportFields(JsonObject event, const ReportMessage &report) {
  event["version"] = report.version;
  event["size"] = report.size;
  event["count"] = report.count;
  JsonArray missing = event["missing"].to<JsonArray>();
  for (uint8_t index = 0; index < report.count; ++index) {
    if (isFragmentMarked(report, index)) {
      missing.add(index);
    }
  }
}

bool TransferService::begin(EventSink &events, NeighborTable &neighbors, TransferListener &listener,
                            uint16_t nodeId) {
  events_ = &events;
  neighbors_ = &neighbors;
  listener_ = &listener;
  nodeId_ = nodeId;
  reception_.reset();
  return verifier_.begin(J5_OPERATOR_PUBLIC_KEY);
}

// ---------------------------------------------------------------------------------------------
// Console

ImageLoad TransferService::loadImage(const char *hexadecimal, char *detail, size_t detailCapacity) {
  ImageRejection rejection(detail, detailCapacity);
  size_t length = 0;
  if (strlen(hexadecimal) > 2 * MAXIMUM_IMAGE_SIZE) {
    rejection.reject(ImageRejectionReason::Format, "longer than %u bytes",
                     static_cast<unsigned>(MAXIMUM_IMAGE_SIZE));
    return ImageLoad::Invalid;
  }
  if (!decodeHexBytes(hexadecimal, consoleImage, sizeof(consoleImage), length)) {
    rejection.reject(ImageRejectionReason::Format, "not hexadecimal");
    return ImageLoad::Invalid;
  }
  ImageHeader header{};
  if (!verifier_.checkFormat(consoleImage, length, header, rejection)) {
    return ImageLoad::Invalid;
  }
  if (header.version <= availableVersion_) {
    snprintf(detail, detailCapacity, "available version %lu",
             static_cast<unsigned long>(availableVersion_));
    return ImageLoad::VersionNotNewer;
  }
  ValidProgram program;
  if (!verifier_.checkSignatureAndProgram(consoleImage, header, program, rejection)) {
    return ImageLoad::Invalid;
  }
  installImage(consoleImage, length, header, program, ImageArrival::Console, 0);
  return ImageLoad::Accepted;
}

void TransferService::reportTransfer() {
  JsonObject event = events_->beginEvent(ConsoleEvent::Transfer);
  event["active"] = listener_->activeVersion();
  event["available"] = availableVersion_;
  if (reception_.isActive()) {
    event["receiving"] = reception_.version();
    event["missing"] = reception_.missingByteCount();
  } else {
    event["receiving"] = nullptr;
    event["missing"] = nullptr;
  }
  event["fragment_size"] = fragmentSize_;
  events_->writeEvent();
}

// ---------------------------------------------------------------------------------------------
// Reception

void TransferService::handleFragment(uint16_t source, const FragmentMessage &fragment, float rssi,
                                     float snr, const RadioSettings &settings, uint32_t nowMillis) {
  FragmentReceipt receipt{};
  if (fragment.version > availableVersion_) {
    receipt =
        reception_.offer(source, fragment, nowMillis, fragmentAirMillis(fragment.size, settings));
  }

  JsonObject event = events_->beginEvent(ConsoleEvent::FragmentRx);
  setNodeId(event, "src", source);
  event["version"] = fragment.version;
  event["index"] = fragment.index;
  event["count"] = fragment.count;
  event["size"] = fragment.size;
  event["remaining"] = fragment.remaining;
  event["accepted"] = receipt.accepted;
  event["new"] = receipt.contributed;
  setLinkQuality(event, rssi, snr);
  events_->writeEvent();

  if (receipt.accepted && reception_.isComplete()) {
    completeReception(nowMillis);
  }
}

void TransferService::completeReception(uint32_t nowMillis) {
  ImageHeader header{};
  ValidProgram program;
  ImageRejection rejection;
  bool valid =
      verifier_.verify(reception_.image(), reception_.imageLength(), header, program, rejection);
  // The fragments name the version too; an image that claims another one is malformed.
  if (valid && header.version != reception_.version()) {
    valid = rejection.reject(ImageRejectionReason::Format, "version does not match the fragments");
  }
  if (!valid) {
    JsonObject event = events_->beginEvent(ConsoleEvent::ImageRejected);
    event["version"] = reception_.version();
    const char *reason = imageRejectionReasonName(rejection.reason());
    event["reason"] = reason;
    setNodeId(event, "src", reception_.lastSource());
    events_->writeEvent();
    events_->debug("image v%lu %s", static_cast<unsigned long>(reception_.version()), reason);
    // Discarded whole: the node waits for the version again.
    reception_.reset();
    return;
  }

  installImage(reception_.image(), reception_.imageLength(), header, program, ImageArrival::Radio,
               nowMillis);
  // A neighbor that already runs the version orders the activation without waiting for its next
  // HELLO (docs/adrs/0011-implicit-activation-without-rollback.md).
  for (const Neighbor &neighbor : neighbors_->neighbors(nowMillis)) {
    if (neighbor.announced.version == header.version) {
      listener_->onActivationWanted(ActivationCause::Neighbor, neighbor.id, nowMillis);
      break;
    }
  }
}

void TransferService::installImage(const uint8_t *image, size_t length, const ImageHeader &header,
                                   const ValidProgram &program, ImageArrival arrival,
                                   uint32_t nowMillis) {
  const bool viaRadio = arrival == ImageArrival::Radio;
  JsonObject event = events_->beginEvent(ConsoleEvent::Image);
  event["version"] = header.version;
  event["size"] = header.programLength;
  event["image_size"] = length;
  event["via"] = imageArrivalName(arrival);
  if (viaRadio) {
    setNodeId(event, "src", reception_.lastSource());
    event["fragments"] = reception_.fragmentCount();
    event["reports"] = reception_.reportCount();
    event["duration"] = nowMillis - reception_.startMillis();
  } else {
    event["src"] = nullptr;
    event["fragments"] = 0;
    event["reports"] = 0;
    event["duration"] = 0;
  }
  events_->writeEvent();

  // The header and the signature as they came; the program through the copy of the valid one.
  memcpy(availableImage_, image, IMAGE_HEADER_SIZE);
  availableProgram_ = program.copyTo(availableImage_ + IMAGE_HEADER_SIZE);
  memcpy(availableImage_ + IMAGE_HEADER_SIZE + program.length(),
         image + IMAGE_HEADER_SIZE + program.length(), IMAGE_SIGNATURE_SIZE);
  availableLength_ = length;
  availableVersion_ = header.version;
  // A reception survives only for a version newer than the available one.
  if (reception_.isActive() && reception_.version() <= availableVersion_) {
    reception_.reset();
  }
  // The available image is the only one the node sends: the bursts of the previous one end here.
  BurstSummary ended{};
  if (bursts_.setImage(availableImage_, availableLength_, availableVersion_, ended)) {
    emitBurstDone(ended);
  }
  bursts_.requestFullBurst(fragmentSize_, viaRadio ? BurstCause::Complete : BurstCause::Load,
                           NO_NODE_ID);
  listener_->onAvailableVersionChanged();
  events_->debug("image v%lu %s", static_cast<unsigned long>(availableVersion_),
                 imageArrivalName(arrival));
}

// ---------------------------------------------------------------------------------------------
// Reports and HELLO

void TransferService::handleReport(const FrameHeader &header, const ReportMessage &report) {
  if (header.destination != nodeId_) {
    return;
  }
  emitReportReceived(header.source, report);
  bursts_.mergeReport(report, header.source);
}

void TransferService::onNeighborHello(uint16_t source, const AnnouncedState &announced,
                                      uint32_t nowMillis) {
  if (announced.available < availableVersion_ && !bursts_.hasBurst()) {
    bursts_.requestFullBurst(fragmentSize_, BurstCause::Hello, source);
  }
  if (announced.version == availableVersion_) {
    listener_->onActivationWanted(ActivationCause::Hello, source, nowMillis);
  }
}

// ---------------------------------------------------------------------------------------------
// Transmission

bool TransferService::isBurstInProgress(uint32_t nowMillis) const {
  return bursts_.hasBurst() || reception_.isBurstInProgress(nowMillis);
}

size_t TransferService::buildNextFrame(uint32_t nowMillis, const RadioSettings &settings,
                                       FrameDescription &description, uint8_t *payload) {
  // The receiver stops reporting while the node that sends is out of its neighbor table, and
  // resumes when it hears that node again.
  if (reception_.isReportDue(nowMillis) &&
      neighbors_->contains(reception_.lastSource(), nowMillis)) {
    ReportMessage report{};
    reception_.buildReport(report);
    reception_.onReportSent(nowMillis, reportAirMillis(report.count, settings) +
                                           fragmentAirMillis(report.size, settings) +
                                           TRANSFER_MARGIN_MS);
    emitReportSent(report);
    description.type = MessageType::Report;
    description.destination = reception_.lastSource();
    description.version = report.version;
    return encodeReport(report, payload);
  }
  FragmentMessage fragment{};
  bool burstStarted = false;
  BurstSummary burst{};
  if (!bursts_.takeNextFragment(fragment, burstStarted, burst)) {
    return 0;
  }
  if (burstStarted) {
    emitBurstStart(burst);
  }
  description.type = MessageType::Fragment;
  description.destination = BROADCAST_NODE_ID;
  description.version = fragment.version;
  description.index = fragment.index;
  return encodeFragment(fragment, payload);
}

void TransferService::onTransmitStarted(const FrameDescription &frame,
                                        const TransmitTiming &timing) {
  if (frame.type == MessageType::Fragment) {
    bursts_.onFragmentStarted(timing.startMicros);
  }
}

void TransferService::onTransmitDone(const FrameDescription &frame, const TransmitTiming &timing) {
  BurstSummary ended{};
  if (frame.type == MessageType::Fragment && bursts_.onFragmentSent(timing.endMicros, ended)) {
    emitBurstDone(ended);
  }
}

void TransferService::onTransmitFailed(const FrameDescription &frame) {
  BurstSummary ended{};
  if (frame.type == MessageType::Fragment && bursts_.onFragmentFailed(ended)) {
    emitBurstDone(ended);
  }
}

void TransferService::emitBurstStart(const BurstSummary &burst) {
  JsonObject event = events_->beginEvent(ConsoleEvent::BurstStart);
  event["version"] = burst.version;
  event["size"] = burst.size;
  event["count"] = burst.initialCount;
  event["cause"] = burstCauseName(burst.cause);
  setOptionalNodeId(event, "trigger", burst.trigger);
  events_->writeEvent();
}

void TransferService::emitBurstDone(const BurstSummary &burst) {
  JsonObject event = events_->beginEvent(ConsoleEvent::BurstDone);
  event["version"] = burst.version;
  event["size"] = burst.size;
  event["sent"] = burst.sent;
  event["duration"] = burst.durationMicros;
  events_->writeEvent();
}

void TransferService::emitReportSent(const ReportMessage &report) {
  JsonObject event = events_->beginEvent(ConsoleEvent::ReportSent);
  setNodeId(event, "dst", reception_.lastSource());
  writeReportFields(event, report);
  event["round"] = reception_.reportCount();
  events_->writeEvent();
}

void TransferService::emitReportReceived(uint16_t source, const ReportMessage &report) {
  JsonObject event = events_->beginEvent(ConsoleEvent::ReportReceived);
  setNodeId(event, "src", source);
  writeReportFields(event, report);
  events_->writeEvent();
}

} // namespace firmware
