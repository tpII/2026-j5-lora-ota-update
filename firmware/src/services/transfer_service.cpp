#include "transfer_service.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "../configuration.h"
#include "../console/event_fields.h"
#include "../radio/time_on_air.h"

namespace firmware {

static_assert(sizeof(J5_OPERATOR_PUBLIC_KEY) == 2 * OPERATOR_PUBLIC_KEY_SIZE + 1,
              "J5_OPERATOR_PUBLIC_KEY must hold 64 hexadecimal digits");

static constexpr size_t DEBUG_TEXT_CAPACITY = 64;

// The image of a load_image command, decoded before it is verified, so that a rejected image
// leaves the available one untouched.
static uint8_t consoleImage[MAXIMUM_IMAGE_SIZE];

static uint32_t roundUpToMillis(uint32_t micros) { return (micros + 999) / 1000; }

static void writeMissingIndices(JsonObject event, const ReportFields &report) {
  JsonArray missing = event["missing"].to<JsonArray>();
  for (uint8_t index = 0; index < report.count; ++index) {
    if (isFragmentMarked(report, index)) {
      missing.add(index);
    }
  }
}

const char *activationCauseName(ActivationCause cause) {
  switch (cause) {
  case ActivationCause::Console:
    return "console";
  case ActivationCause::Hello:
    return "hello";
  case ActivationCause::Neighbor:
    return "neighbor";
  }
  return "console";
}

bool TransferService::begin(Console &console, DebugDisplay &display, const NeighborTable &neighbors,
                            const RadioSettings &settings) {
  console_ = &console;
  display_ = &display;
  neighbors_ = &neighbors;
  settings_ = &settings;
  reception_.reset();
  return verifier_.begin(J5_OPERATOR_PUBLIC_KEY);
}

// ---------------------------------------------------------------------------------------------
// Console

ImageLoad TransferService::loadImage(const char *hexadecimal, char *detail, size_t detailCapacity) {
  size_t length = 0;
  if (strlen(hexadecimal) > 2 * MAXIMUM_IMAGE_SIZE) {
    snprintf(detail, detailCapacity, "format: longer than %u bytes",
             static_cast<unsigned>(MAXIMUM_IMAGE_SIZE));
    return ImageLoad::Invalid;
  }
  if (!decodeHexBytes(hexadecimal, consoleImage, sizeof(consoleImage), length)) {
    snprintf(detail, detailCapacity, "format: not hexadecimal");
    return ImageLoad::Invalid;
  }
  // First the format, then the version and last the signature and the program.
  ImageHeader header{};
  if (verifier_.checkFormat(consoleImage, length, header, detail, detailCapacity) !=
      ImageCheck::Valid) {
    return ImageLoad::Invalid;
  }
  if (header.version <= availableVersion_) {
    snprintf(detail, detailCapacity, "available version %lu",
             static_cast<unsigned long>(availableVersion_));
    return ImageLoad::VersionNotNewer;
  }
  if (verifier_.checkSignatureAndProgram(consoleImage, header, detail, detailCapacity) !=
      ImageCheck::Valid) {
    return ImageLoad::Invalid;
  }
  installImage(consoleImage, length, header, false, 0);
  return ImageLoad::Accepted;
}

void TransferService::emitTransfer(uint32_t activeVersion) {
  JsonObject event = console_->beginEvent("transfer");
  event["active"] = activeVersion;
  event["available"] = availableVersion_;
  if (reception_.isActive()) {
    event["receiving"] = reception_.version();
    event["missing"] = reception_.missingByteCount();
  } else {
    event["receiving"] = nullptr;
    event["missing"] = nullptr;
  }
  event["fragment_size"] = fragmentSize_;
  console_->writeEvent();
}

// ---------------------------------------------------------------------------------------------
// Reception

void TransferService::handleFragment(uint16_t source, const uint8_t *payload, size_t length,
                                     float rssi, float snr, uint32_t nowMillis) {
  FragmentFields fields{};
  decodeFragment(payload, length, fields);
  FragmentReceipt receipt{};
  // Only versions newer than the available one are received.
  if (fields.version > availableVersion_) {
    receipt = reception_.offer(source, fields, nowMillis, fragmentAirMillis(fields.size));
  }

  JsonObject event = console_->beginEvent("fragment_rx");
  setNodeId(event, "src", source);
  event["version"] = fields.version;
  event["index"] = fields.index;
  event["count"] = fields.count;
  event["size"] = fields.size;
  event["remaining"] = fields.remaining;
  event["accepted"] = receipt.accepted;
  event["new"] = receipt.contributed;
  event["rssi"] = roundToDecimals(rssi, 1);
  event["snr"] = roundToDecimals(snr, 2);
  console_->writeEvent();

  if (receipt.accepted && reception_.isComplete()) {
    completeReception(nowMillis);
  }
}

void TransferService::completeReception(uint32_t nowMillis) {
  char detail[48];
  ImageHeader header{};
  ImageCheck check = verifier_.verify(reception_.image(), reception_.imageLength(), header, detail,
                                      sizeof(detail));
  // The fragments name the version too; an image that claims another one is malformed.
  if (check == ImageCheck::Valid && header.version != reception_.version()) {
    check = ImageCheck::Format;
  }
  if (check != ImageCheck::Valid) {
    JsonObject event = console_->beginEvent("image_rejected");
    event["version"] = reception_.version();
    event["reason"] = imageCheckName(check);
    setNodeId(event, "src", reception_.lastSource());
    console_->writeEvent();
    debug("image v%lu %s", static_cast<unsigned long>(reception_.version()), imageCheckName(check));
    // Discarded whole: the node waits for the version again.
    reception_.reset();
    return;
  }

  installImage(reception_.image(), reception_.imageLength(), header, true, nowMillis);
  // A neighbor that already runs the version orders the activation without waiting for its next
  // HELLO (docs/adrs/0011-implicit-activation-without-rollback.md).
  for (size_t index = 0; index < neighbors_->count(); ++index) {
    const Neighbor &neighbor = neighbors_->at(index);
    if (neighbor.version == header.version) {
      requestActivation(ActivationCause::Neighbor, neighbor.id);
      break;
    }
  }
}

void TransferService::installImage(const uint8_t *image, size_t length, const ImageHeader &header,
                                   bool viaRadio, uint32_t nowMillis) {
  JsonObject event = console_->beginEvent("image");
  event["version"] = header.version;
  event["size"] = header.programLength;
  event["image_size"] = length;
  event["via"] = viaRadio ? "radio" : "console";
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
  console_->writeEvent();

  // The available image is the only one the node sends: the bursts of the previous one end here.
  if (bursts_.hasStartedBurst()) {
    emitBurstDone();
  }
  if (image != availableImage_) {
    memmove(availableImage_, image, length);
  }
  availableLength_ = length;
  availableVersion_ = header.version;
  availableHeader_ = header;
  // A reception survives only for a version newer than the available one.
  if (reception_.isActive() && reception_.version() <= availableVersion_) {
    reception_.reset();
  }
  bursts_.setImage(availableImage_, availableLength_, availableVersion_);
  bursts_.requestFullBurst(fragmentSize_, viaRadio ? BurstCause::Complete : BurstCause::Load, 0);
  versionChanged_ = true;
  debug("image v%lu %s", static_cast<unsigned long>(availableVersion_),
        viaRadio ? "radio" : "console");
}

// ---------------------------------------------------------------------------------------------
// Reports and HELLO

void TransferService::handleReport(uint16_t source, const uint8_t *payload, size_t length) {
  ReportFields report{};
  decodeReport(payload, length, report);
  emitReport("report_received", "src", source, report, 0);
  // Only the available image is sent; a report of any other version is ignored.
  if (availableVersion_ != 0 && report.version == availableVersion_) {
    bursts_.mergeReport(report, source);
  }
}

void TransferService::handleHello(uint16_t source, uint32_t activeVersion,
                                  uint32_t availableVersion, uint32_t ownActiveVersion) {
  if (availableVersion_ != 0 && availableVersion < availableVersion_ && !bursts_.hasBurst()) {
    bursts_.requestFullBurst(fragmentSize_, BurstCause::Hello, source);
  }
  if (activeVersion == availableVersion_ && availableVersion_ > ownActiveVersion) {
    requestActivation(ActivationCause::Hello, source);
  }
}

void TransferService::requestActivation(ActivationCause cause, uint16_t source) {
  activationRequested_ = true;
  activation_.cause = cause;
  activation_.source = source;
}

bool TransferService::takeVersionChange() {
  const bool changed = versionChanged_;
  versionChanged_ = false;
  return changed;
}

bool TransferService::takeActivationRequest(ActivationRequest &request) {
  if (!activationRequested_) {
    return false;
  }
  activationRequested_ = false;
  request = activation_;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Transmission

bool TransferService::isBurstInProgress(uint32_t nowMillis) const {
  return bursts_.hasBurst() || reception_.isBurstInProgress(nowMillis);
}

size_t TransferService::buildNextFrame(uint32_t nowMillis, MessageType &type, uint16_t &destination,
                                       uint8_t *payload) {
  // The receiver stops reporting while the node that sends is out of its neighbor table, and
  // resumes when it hears that node again.
  if (reception_.isReportDue(nowMillis) && neighbors_->contains(reception_.lastSource())) {
    ReportFields report{};
    reception_.buildReport(report);
    reception_.onReportSent(nowMillis, reportAirMillis(report.count) +
                                           fragmentAirMillis(report.size) + TRANSFER_MARGIN_MS);
    emitReport("report_sent", "dst", reception_.lastSource(), report, reception_.reportCount());
    type = MessageType::Report;
    destination = reception_.lastSource();
    return encodeReport(report, payload);
  }
  if (bursts_.isFragmentDue()) {
    bool burstStarted = false;
    const size_t length = bursts_.buildNextFragment(payload, burstStarted);
    if (length == 0) {
      return 0;
    }
    if (burstStarted) {
      const Burst &burst = bursts_.currentBurst();
      JsonObject event = console_->beginEvent("burst_start");
      event["version"] = bursts_.version();
      event["size"] = burst.size;
      event["count"] = burst.initialCount;
      event["cause"] = burstCauseName(burst.cause);
      if (burst.cause == BurstCause::Hello || burst.cause == BurstCause::Report) {
        setNodeId(event, "trigger", burst.trigger);
      } else {
        event["trigger"] = nullptr;
      }
      console_->writeEvent();
    }
    type = MessageType::Fragment;
    destination = BROADCAST_NODE_ID;
    return length;
  }
  return 0;
}

void TransferService::onFragmentStarted(int64_t startMicros) {
  bursts_.onFragmentStarted(startMicros);
}

void TransferService::onFragmentSent(uint32_t version, int64_t endMicros) {
  if (bursts_.onFragmentSent(version, endMicros)) {
    emitBurstDone();
  }
}

void TransferService::onFragmentFailed(uint32_t version) {
  if (bursts_.onFragmentFailed(version)) {
    emitBurstDone();
  }
}

void TransferService::emitBurstDone() {
  const Burst &burst = bursts_.currentBurst();
  JsonObject event = console_->beginEvent("burst_done");
  event["version"] = bursts_.version();
  event["size"] = burst.size;
  event["sent"] = burst.sent;
  event["duration"] = burst.sent > 0 ? burst.lastEndMicros - burst.firstStartMicros : 0;
  console_->writeEvent();
  bursts_.finishBurst();
}

void TransferService::emitReport(const char *name, const char *peerKey, uint16_t peer,
                                 const ReportFields &report, int round) {
  JsonObject event = console_->beginEvent(name);
  setNodeId(event, peerKey, peer);
  event["version"] = report.version;
  event["size"] = report.size;
  event["count"] = report.count;
  writeMissingIndices(event, report);
  if (round > 0) {
    event["round"] = round;
  }
  console_->writeEvent();
}

uint32_t TransferService::fragmentAirMillis(uint8_t size) const {
  return roundUpToMillis(
      computeTimeOnAirMicros(FRAME_OVERHEAD + FRAGMENT_HEADER_SIZE + size, *settings_));
}

uint32_t TransferService::reportAirMillis(uint8_t count) const {
  return roundUpToMillis(computeTimeOnAirMicros(
      FRAME_OVERHEAD + REPORT_FIXED_SIZE + reportBitmapSize(count), *settings_));
}

void TransferService::debug(const char *format, ...) {
  char text[DEBUG_TEXT_CAPACITY];
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(text, sizeof(text), format, arguments);
  va_end(arguments);
  console_->writeDebug(text);
  display_->appendLine(text);
}

} // namespace firmware
