// Host tests of the response deadlines of the protocol contract.

#include "generated_test_vectors.h"
#include "host_test_harness.h"
#include "protocol/protocol_contract.h"

using namespace firmware;

J5_HOST_TEST(testResponseDeadlines) {
  // The cases that the control panel checks too.
  for (const EchoLossDeadlineVector &reference : ECHO_LOSS_DEADLINE_VECTORS) {
    CHECK(echoLossDeadlineMillis(reference.requestTimeOnAirMicros) == reference.expectedMillis);
  }
  for (const RunReceptionDeadlineVector &reference : RUN_RECEPTION_DEADLINE_VECTORS) {
    CHECK(runReceptionDeadlineMillis(reference.intervalMillis, reference.packetTimeOnAirMicros) ==
          reference.expectedMillis);
  }
}
