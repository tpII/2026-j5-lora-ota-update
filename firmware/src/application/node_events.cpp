#include "node_events.h"

#include "../configuration.h"

namespace firmware {

void writeBootEvent(EventSink &events, uint16_t nodeId, BoardModel model, uint8_t epoch) {
  JsonObject event = events.beginEvent(ConsoleEvent::Boot);
  setNodeId(event, "id", nodeId);
  event["model"] = boardModelName(model);
  event["epoch"] = epoch;
  event["firmware"] = FIRMWARE_VERSION;
  event["protocol"] = PROTOCOL_VERSION;
  event["key"] = keyKindName(J5_NETWORK_KEY_IS_DEFAULT ? KeyKind::Default : KeyKind::Custom);
  event["operator_key"] =
      keyKindName(J5_OPERATOR_PUBLIC_KEY_IS_DEFAULT ? KeyKind::Default : KeyKind::Custom);
  events.writeEvent();
}

void writeStatusEvent(EventSink &events, uint16_t nodeId, BoardModel model, uint8_t epoch,
                      const NodeCounters &counters) {
  JsonObject event = events.beginEvent(ConsoleEvent::Status);
  setNodeId(event, "id", nodeId);
  event["model"] = boardModelName(model);
  event["epoch"] = epoch;
  event["tx"] = counters.transmitted;
  event["rx"] = counters.received;
  event["dropped"] = counters.droppedLines;
  event["heap"] = counters.freeHeap;
  events.writeEvent();
}

void writeRadioEvent(EventSink &events, const RadioSettings &settings, int8_t transceiverPower,
                     BoardModel model) {
  JsonObject event = events.beginEvent(ConsoleEvent::Radio);
  event["freq"] = roundToDecimals(settings.frequencyMhz, FREQUENCY_DECIMALS);
  event["sf"] = settings.spreadingFactor;
  event["bw"] = settings.bandwidthKhz;
  event["cr"] = settings.codingRateDenominator;
  event["preamble"] = settings.preambleLength;
  event["sync"] = settings.syncWord;
  event["power"] = settings.transmitPowerDbm;
  event["chip"] = transceiverPower;
  if (hasLowNoiseAmplifier(model)) {
    event["lna"] = lnaModeName(settings.lowNoiseAmplifierEnabled ? LnaMode::On : LnaMode::Bypass);
  } else {
    event["lna"] = nullptr;
  }
  events.writeEvent();
}

void writeWifiEvent(EventSink &events, bool enabled, const char *ssid, uint8_t channel,
                    uint8_t clients) {
  JsonObject event = events.beginEvent(ConsoleEvent::Wifi);
  event["state"] = wifiStateName(enabled ? WifiState::On : WifiState::Off);
  event["ssid"] = ssid;
  event["channel"] = channel;
  event["clients"] = clients;
  events.writeEvent();
}

void writeTransmissionEvent(EventSink &events, const FrameDescription &description, size_t length,
                            const TransmitTiming &timing) {
  JsonObject event = events.beginEvent(ConsoleEvent::Tx);
  event["type"] = messageTypeName(description.type);
  setNodeId(event, "dst", description.destination);
  event["seq"] = description.sequence;
  event["size"] = length;
  event["toa"] = static_cast<uint32_t>(timing.endMicros - timing.startMicros);
  event["toa_calc"] = timing.calculatedTimeOnAirMicros;
  switch (description.type) {
  case MessageType::Test:
    event["run"] = description.run;
    event["index"] = description.index;
    break;
  case MessageType::Fragment:
    event["version"] = description.version;
    event["index"] = description.index;
    break;
  case MessageType::Report:
    event["version"] = description.version;
    break;
  case MessageType::Hello:
  case MessageType::EchoRequest:
  case MessageType::EchoReply:
    break;
  }
  events.writeEvent();
}

void writeDropEvent(EventSink &events, DropReason reason, const ReceivedFrame &frame) {
  JsonObject event = events.beginEvent(ConsoleEvent::Drop);
  event["reason"] = dropReasonName(reason);
  event["size"] = frame.length;
  setLinkQuality(event, frame.rssi, frame.snr);
  events.writeEvent();
}

void writeDuplicateEvent(EventSink &events, const FrameHeader &header, MessageType type) {
  JsonObject event = events.beginEvent(ConsoleEvent::Duplicate);
  setNodeId(event, "src", header.source);
  event["epoch"] = header.epoch;
  event["seq"] = header.sequence;
  event["type"] = messageTypeName(type);
  events.writeEvent();
}

void writeIdConflictEvent(EventSink &events, const FrameHeader &header,
                          const ReceivedFrame &frame) {
  JsonObject event = events.beginEvent(ConsoleEvent::IdConflict);
  event["epoch"] = header.epoch;
  event["seq"] = header.sequence;
  setLinkQuality(event, frame.rssi, frame.snr);
  events.writeEvent();
  events.debug("id conflict");
}

} // namespace firmware
