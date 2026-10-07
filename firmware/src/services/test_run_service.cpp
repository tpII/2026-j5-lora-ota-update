#include "test_run_service.h"

#include <string.h>

#include "../network/byte_order.h"

namespace firmware {

uint16_t TestRunService::startSending(uint16_t count, uint16_t size, uint16_t interval,
                                      uint32_t nowMillis) {
  sender_ = SenderRun{};
  sender_.active = true;
  sender_.run = nextRunNumber_++;
  if (nextRunNumber_ == 0) {
    nextRunNumber_ = 1;
  }
  sender_.count = count;
  sender_.size = size;
  sender_.interval = interval;
  sender_.nextTransmitMillis = nowMillis;
  return sender_.run;
}

bool TestRunService::isFrameDue(uint32_t nowMillis) const {
  return sender_.active && !sender_.stopRequested && !sender_.frameInFlight &&
         sender_.nextIndex < sender_.count &&
         static_cast<int32_t>(nowMillis - sender_.nextTransmitMillis) >= 0;
}

size_t TestRunService::buildNextPayload(uint8_t *output) {
  TestFields fields{};
  fields.run = sender_.run;
  fields.index = sender_.nextIndex;
  fields.count = sender_.count;
  fields.interval = sender_.interval;
  sender_.frameInFlight = true;
  return encodePayload(fields, sender_.size, output);
}

void TestRunService::onFrameStarted(int64_t startMicros) {
  if (!sender_.active || !sender_.frameInFlight) {
    return;
  }
  if (sender_.sent == 0) {
    sender_.firstStartMicros = startMicros;
  }
}

bool TestRunService::onFrameSent(int64_t endMicros, uint32_t nowMillis) {
  if (!sender_.active || !sender_.frameInFlight) {
    return false;
  }
  sender_.frameInFlight = false;
  ++sender_.sent;
  ++sender_.nextIndex;
  sender_.lastEndMicros = endMicros;
  sender_.nextTransmitMillis = nowMillis + sender_.interval;
  return sender_.nextIndex >= sender_.count || sender_.stopRequested;
}

void TestRunService::onFrameFailed() {
  sender_.frameInFlight = false;
  sender_.stopRequested = true;
}

bool TestRunService::isReceiving() const {
  for (const ReceiverRun &run : receivers_) {
    if (run.active) {
      return true;
    }
  }
  return false;
}

ReceiverRun *TestRunService::findActiveRun(uint16_t source) {
  for (ReceiverRun &run : receivers_) {
    if (run.active && run.source == source) {
      return &run;
    }
  }
  return nullptr;
}

ReceiverRun *TestRunService::recordTestFrame(uint16_t source, const TestFields &fields, float rssi,
                                             float snr, uint32_t nowMillis,
                                             uint32_t timeOnAirMillis, bool &opened,
                                             bool &completed) {
  opened = false;
  completed = false;
  ReceiverRun *run = findActiveRun(source);
  if (run != nullptr && run->run != fields.run) {
    run = nullptr;
  }
  if (run == nullptr) {
    for (ReceiverRun &candidate : receivers_) {
      if (!candidate.active) {
        run = &candidate;
        break;
      }
    }
    if (run == nullptr) {
      return nullptr;
    }
    *run = ReceiverRun{};
    run->active = true;
    run->source = source;
    run->run = fields.run;
    run->count = fields.count;
    run->interval = fields.interval;
    run->rssiMinimum = rssi;
    run->rssiMaximum = rssi;
    run->firstMillis = nowMillis;
    opened = true;
  }

  ++run->received;
  run->rssiSum += rssi;
  run->snrSum += snr;
  if (rssi < run->rssiMinimum) {
    run->rssiMinimum = rssi;
  }
  if (rssi > run->rssiMaximum) {
    run->rssiMaximum = rssi;
  }
  run->lastMillis = nowMillis;
  // Without frames for twice the interval plus the time on air, and a margin, the run is over.
  run->deadlineMillis = nowMillis + 2 * (static_cast<uint32_t>(fields.interval) + timeOnAirMillis) +
                        RESPONSE_MARGIN_MS;
  completed = fields.index + 1 >= fields.count;
  return run;
}

ReceiverRun *TestRunService::findExpiredRun(uint32_t nowMillis) {
  for (ReceiverRun &run : receivers_) {
    if (run.active && static_cast<int32_t>(nowMillis - run.deadlineMillis) >= 0) {
      return &run;
    }
  }
  return nullptr;
}

size_t TestRunService::encodePayload(const TestFields &fields, uint16_t size, uint8_t *output) {
  memset(output, 0, size);
  writeUint16(output, fields.run);
  writeUint16(output + 2, fields.index);
  writeUint16(output + 4, fields.count);
  writeUint16(output + 6, fields.interval);
  return size;
}

bool TestRunService::decodePayload(const uint8_t *payload, size_t length, TestFields &fields) {
  if (length < TEST_FIELDS_SIZE) {
    return false;
  }
  fields.run = readUint16(payload);
  fields.index = readUint16(payload + 2);
  fields.count = readUint16(payload + 4);
  fields.interval = readUint16(payload + 6);
  return fields.count > 0 && fields.index < fields.count;
}

} // namespace firmware
