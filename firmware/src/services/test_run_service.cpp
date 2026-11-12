#include "test_run_service.h"

#include <math.h>

#include "../radio/time_on_air.h"
#include "../timing/millisecond_clock.h"

namespace firmware {

void TestRunService::startSending(uint16_t count, uint16_t size, uint16_t interval,
                                  uint32_t nowMillis) {
  sender_ = SenderRun{};
  sender_.active = true;
  sender_.outcome = SenderOutcome::InProgress;
  sender_.run = nextRunNumber_++;
  if (nextRunNumber_ == 0) {
    nextRunNumber_ = 1;
  }
  sender_.count = count;
  sender_.size = size;
  sender_.interval = interval;
  sender_.nextTransmitMillis = nowMillis;

  JsonObject event = events_->beginEvent(ConsoleEvent::RunStart);
  event["run"] = sender_.run;
  event["count"] = count;
  event["size"] = size;
  event["interval"] = interval;
  events_->writeEvent();
  events_->debug("run %u start %lux%lu", sender_.run, static_cast<unsigned long>(count),
                 static_cast<unsigned long>(size));
}

void TestRunService::requestStop() {
  if (sender_.outcome == SenderOutcome::InProgress) {
    sender_.outcome = SenderOutcome::Stopped;
  }
}

bool TestRunService::isFrameDue(uint32_t nowMillis) const {
  return sender_.active && sender_.outcome == SenderOutcome::InProgress && !sender_.frameInFlight &&
         sender_.span.sentCount() < sender_.count &&
         hasReached(nowMillis, sender_.nextTransmitMillis);
}

size_t TestRunService::buildNextFrame(FrameDescription &description, uint8_t *payload) {
  TestMessage message{};
  message.run = sender_.run;
  message.index = sender_.span.sentCount();
  message.count = sender_.count;
  message.interval = sender_.interval;
  message.size = sender_.size;
  sender_.frameInFlight = true;
  description.type = MessageType::Test;
  description.destination = BROADCAST_NODE_ID;
  description.run = message.run;
  description.index = message.index;
  return encodeTest(message, payload);
}

void TestRunService::onTransmitStarted(const FrameDescription &, const TransmitTiming &timing) {
  sender_.span.recordStart(timing.startMicros);
}

void TestRunService::onTransmitDone(const FrameDescription &, const TransmitTiming &timing) {
  const bool wasActive = isActive();
  sender_.frameInFlight = false;
  sender_.span.recordEnd(timing.endMicros);
  sender_.nextTransmitMillis = timing.nowMillis + sender_.interval;
  finishSendingIfOver();
  notifyIfEnded(wasActive, timing.nowMillis);
}

void TestRunService::onTransmitFailed(const FrameDescription &) {
  sender_.frameInFlight = false;
  if (sender_.outcome == SenderOutcome::InProgress) {
    sender_.outcome = SenderOutcome::Failed;
  }
}

void TestRunService::finishSendingIfOver() {
  if (!sender_.active || sender_.frameInFlight ||
      (sender_.outcome == SenderOutcome::InProgress && sender_.span.sentCount() < sender_.count)) {
    return;
  }
  JsonObject event = events_->beginEvent(ConsoleEvent::RunDone);
  event["run"] = sender_.run;
  event["count"] = sender_.count;
  event["sent"] = sender_.span.sentCount();
  event["duration"] = sender_.span.durationMicros();
  // The contract has one mark for both ways of ending early: a stop and a frame that did not go
  // out.
  event["aborted"] = sender_.outcome != SenderOutcome::InProgress;
  events_->writeEvent();
  events_->debug("run %u done %u/%u", sender_.run, sender_.span.sentCount(), sender_.count);
  sender_.active = false;
}

void TestRunService::notifyIfEnded(bool wasActive, uint32_t nowMillis) {
  if (wasActive && !isActive()) {
    listener_->onRunsEnded(nowMillis);
  }
}

bool TestRunService::isReceiving() const {
  for (const ReceiverRun &run : receivers_) {
    if (run.active) {
      return true;
    }
  }
  return false;
}

TestRunService::ReceiverRun *TestRunService::findActiveRun(uint16_t source) {
  for (ReceiverRun &run : receivers_) {
    if (run.active && run.source == source) {
      return &run;
    }
  }
  return nullptr;
}

TestRunService::ReceiverRun *TestRunService::openRun(uint16_t source, const TestMessage &message,
                                                     float rssi, uint32_t nowMillis) {
  for (ReceiverRun &run : receivers_) {
    if (!run.active) {
      run = ReceiverRun{};
      run.active = true;
      run.source = source;
      run.run = message.run;
      run.count = message.count;
      run.rssiMinimum = rssi;
      run.rssiMaximum = rssi;
      run.firstMillis = nowMillis;
      return &run;
    }
  }
  return nullptr;
}

void TestRunService::handleTestFrame(const FrameHeader &header, const TestMessage &message,
                                     const ReceivedFrame &frame, const RadioSettings &settings,
                                     uint32_t nowMillis) {
  const bool wasActive = isActive();
  ReceiverRun *run = findActiveRun(header.source);
  if (run != nullptr && run->run != message.run) {
    finishReceiving(*run, RunEndReason::Timeout);
    run = nullptr;
  }
  const bool opened = run == nullptr;
  if (opened) {
    run = openRun(header.source, message, frame.rssi, nowMillis);
  }
  if (run != nullptr) {
    ++run->received;
    run->rssiSum += frame.rssi;
    run->snrSum += frame.snr;
    if (frame.rssi < run->rssiMinimum) {
      run->rssiMinimum = frame.rssi;
    }
    if (frame.rssi > run->rssiMaximum) {
      run->rssiMaximum = frame.rssi;
    }
    run->lastMillis = nowMillis;
    run->deadlineMillis =
        nowMillis + runReceptionDeadlineMillis(message.interval,
                                               computeTimeOnAirMicros(frame.length, settings));
  }

  JsonObject event = events_->beginEvent(ConsoleEvent::TestRx);
  setNodeId(event, "src", header.source);
  event["run"] = message.run;
  event["index"] = message.index;
  event["count"] = message.count;
  event["size"] = message.size;
  setLinkQuality(event, frame.rssi, frame.snr);
  event["ferr"] = lroundf(frame.frequencyError);
  events_->writeEvent();

  // Without a free slot the frame is reported but not counted.
  if (run != nullptr) {
    if (opened) {
      events_->debug("run %u from %04X", message.run, header.source);
    }
    if (message.index + 1 >= message.count) {
      finishReceiving(*run, RunEndReason::Complete);
    }
  }
  notifyIfEnded(wasActive, nowMillis);
}

void TestRunService::poll(uint32_t nowMillis) {
  const bool wasActive = isActive();
  for (ReceiverRun &run : receivers_) {
    if (run.active && hasReached(nowMillis, run.deadlineMillis)) {
      finishReceiving(run, RunEndReason::Timeout);
    }
  }
  finishSendingIfOver();
  notifyIfEnded(wasActive, nowMillis);
}

void TestRunService::finishReceiving(ReceiverRun &run, RunEndReason reason) {
  JsonObject event = events_->beginEvent(ConsoleEvent::RunEnd);
  setNodeId(event, "src", run.source);
  event["run"] = run.run;
  event["count"] = run.count;
  event["received"] = run.received;
  event["pdr"] = roundToDecimals(static_cast<double>(run.received) / run.count,
                                 PACKET_DELIVERY_RATIO_DECIMALS);
  // A run opens with its first frame, so it always has one to average.
  setRssi(event, "rssi_avg", run.rssiSum / run.received);
  setRssi(event, "rssi_min", run.rssiMinimum);
  setRssi(event, "rssi_max", run.rssiMaximum);
  setSnr(event, "snr_avg", run.snrSum / run.received);
  event["first"] = run.firstMillis;
  event["last"] = run.lastMillis;
  event["reason"] = runEndReasonName(reason);
  events_->writeEvent();
  events_->debug("run %u end %u/%u", run.run, run.received, run.count);
  run.active = false;
}

} // namespace firmware
