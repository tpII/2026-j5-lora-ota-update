#include "host_test_harness.h"

#include <cstdio>

#include "console_line_recorder.h"
#include <sodium.h>

namespace {

struct HostTestList {
  HostTestRegistration *first = nullptr;
  HostTestRegistration *last = nullptr;
};

} // namespace

// A function-local static, so that it exists before the registrations of every file.
static HostTestList &hostTests() {
  static HostTestList list;
  return list;
}

static int failureCount = 0;

HostTestRegistration::HostTestRegistration(const char *testName, HostTestFunction testFunction)
    : name(testName), function(testFunction) {
  HostTestList &list = hostTests();
  if (list.last == nullptr) {
    list.first = this;
  } else {
    list.last->next = this;
  }
  list.last = this;
}

void recordCheck(bool condition, const char *description, const char *file, int line) {
  if (!condition) {
    std::printf("FAIL (%s:%d): %s\n", file, line, description);
    ++failureCount;
  }
}

// With an argument, also writes there the event lines that the tests produced.
int main(int argumentCount, char **arguments) {
  if (sodium_init() < 0) {
    std::printf("libsodium did not start.\n");
    return 1;
  }
  int testCount = 0;
  for (HostTestRegistration *test = hostTests().first; test != nullptr; test = test->next) {
    test->function();
    ++testCount;
  }
  if (argumentCount > 1 && !writeRecordedConsoleLines(arguments[1])) {
    return 1;
  }
  for (const std::string &name : unrecordedConsoleEvents()) {
    std::printf("FAIL: no host test writes the %s event of the contract.\n", name.c_str());
    ++failureCount;
  }
  if (failureCount == 0) {
    std::printf("All %d host tests passed.\n", testCount);
    return 0;
  }
  std::printf("%d host test checks failed.\n", failureCount);
  return 1;
}
