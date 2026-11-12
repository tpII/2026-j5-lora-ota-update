#include "hello_message.h"

#include "../encoding/byte_order.h"
#include "link_quality.h"

namespace firmware {

// The byte vm carries the code of a VmFault in the bits of VM_STATUS_FAULT_MASK. The codes are
// wire format: they must run without gaps from None, code 0, and fit the mask.
static constexpr bool areVmFaultCodesContiguous() {
  for (size_t code = 0; code < VM_FAULT_COUNT; ++code) {
    if (!isKnownVmFault(static_cast<uint8_t>(code))) {
      return false;
    }
  }
  return !isKnownVmFault(static_cast<uint8_t>(VM_FAULT_COUNT));
}

static_assert(static_cast<uint8_t>(VmFault::None) == 0, "code 0 of the byte vm means no fault");
static_assert(areVmFaultCodesContiguous(), "the VmFault codes run from 0 to VM_FAULT_COUNT - 1");
static_assert(VM_FAULT_COUNT - 1 <= VM_STATUS_FAULT_MASK, "every VmFault code fits the byte vm");
static_assert((VM_STATUS_FAULT_MASK & VM_STATUS_FAILING_BIT) == 0,
              "the failing bit lies outside the fault code");

static uint8_t encodeVmStatus(VmFault lastFault, bool faultedSinceReport) {
  return static_cast<uint8_t>((static_cast<uint8_t>(lastFault) & VM_STATUS_FAULT_MASK) |
                              (faultedSinceReport ? VM_STATUS_FAILING_BIT : 0));
}

static VmFault decodeVmStatusFault(uint8_t status) {
  const uint8_t code = status & VM_STATUS_FAULT_MASK;
  return isKnownVmFault(code) ? static_cast<VmFault>(code) : VmFault::None;
}

size_t encodeHello(const HelloMessage &message, uint8_t *output) {
  const AnnouncedState &announced = message.announced;
  const uint8_t count =
      message.neighborCount <= MAXIMUM_NEIGHBORS ? message.neighborCount : MAXIMUM_NEIGHBORS;
  output[HELLO_MODEL_OFFSET] = static_cast<uint8_t>(announced.model);
  writeUint32(output + HELLO_VERSION_OFFSET, announced.version);
  writeUint32(output + HELLO_AVAILABLE_OFFSET, announced.available);
  output[HELLO_VM_STATUS_OFFSET] = encodeVmStatus(announced.lastFault, announced.vmFailing);
  writeUint32(output + HELLO_TRANSMITTED_OFFSET, announced.transmitted);
  output[HELLO_NEIGHBOR_COUNT_OFFSET] = count;
  uint8_t *entry = output + HELLO_FIXED_SIZE;
  for (uint8_t index = 0; index < count; ++index) {
    writeUint16(entry + HELLO_NEIGHBOR_ID_OFFSET, message.neighbors[index].id);
    entry[HELLO_NEIGHBOR_RSSI_OFFSET] = encodeRssi(message.neighbors[index].rssi);
    entry[HELLO_NEIGHBOR_SNR_OFFSET] = encodeSnr(message.neighbors[index].snr);
    entry += HELLO_NEIGHBOR_SIZE;
  }
  return HELLO_FIXED_SIZE + count * HELLO_NEIGHBOR_SIZE;
}

bool decodeHello(const uint8_t *payload, size_t length, HelloMessage &message) {
  if (length < HELLO_FIXED_SIZE) {
    return false;
  }
  const uint8_t count = payload[HELLO_NEIGHBOR_COUNT_OFFSET];
  if (count > MAXIMUM_NEIGHBORS || length != HELLO_FIXED_SIZE + count * HELLO_NEIGHBOR_SIZE) {
    return false;
  }
  AnnouncedState &announced = message.announced;
  const uint8_t model = payload[HELLO_MODEL_OFFSET];
  const uint8_t vmStatus = payload[HELLO_VM_STATUS_OFFSET];
  announced.modelKnown = isKnownBoardModel(model);
  announced.model = static_cast<BoardModel>(model);
  announced.lastFault = decodeVmStatusFault(vmStatus);
  announced.vmFailing = (vmStatus & VM_STATUS_FAILING_BIT) != 0;
  announced.version = readUint32(payload + HELLO_VERSION_OFFSET);
  announced.available = readUint32(payload + HELLO_AVAILABLE_OFFSET);
  announced.transmitted = readUint32(payload + HELLO_TRANSMITTED_OFFSET);
  message.neighborCount = count;
  const uint8_t *entry = payload + HELLO_FIXED_SIZE;
  for (uint8_t index = 0; index < count; ++index) {
    message.neighbors[index].id = readUint16(entry + HELLO_NEIGHBOR_ID_OFFSET);
    message.neighbors[index].rssi = decodeRssi(entry[HELLO_NEIGHBOR_RSSI_OFFSET]);
    message.neighbors[index].snr = decodeSnr(entry[HELLO_NEIGHBOR_SNR_OFFSET]);
    entry += HELLO_NEIGHBOR_SIZE;
  }
  return true;
}

} // namespace firmware
