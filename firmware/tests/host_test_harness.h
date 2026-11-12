#ifndef J5_HOST_TEST_HARNESS_H
#define J5_HOST_TEST_HARNESS_H

// Harness of the host tests: every test registers itself with J5_HOST_TEST, and main() in
// host_test_harness.cpp runs them in the order of their files and of their definitions.

using HostTestFunction = void (*)();

struct HostTestRegistration {
  HostTestRegistration(const char *name, HostTestFunction function);

  const char *name;
  HostTestFunction function;
  HostTestRegistration *next = nullptr;
};

void recordCheck(bool condition, const char *description, const char *file, int line);

#define CHECK(condition) recordCheck((condition), #condition, __FILE__, __LINE__)

#define J5_HOST_TEST(name)                                                                         \
  static void name();                                                                              \
  static HostTestRegistration name##Registration(#name, name);                                     \
  static void name()

#endif
