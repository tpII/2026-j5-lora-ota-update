#ifndef J5_TRANSMISSION_SPAN_H
#define J5_TRANSMISSION_SPAN_H

#include <stdint.h>

namespace firmware {

// Frames sent one after another, as a burst or a run reports them: how many were sent and the time
// from the start of the first one to the end of the last one.
class TransmissionSpan {
public:
  void recordStart(int64_t startMicros) {
    if (!started_) {
      started_ = true;
      firstStartMicros_ = startMicros;
    }
  }
  void recordEnd(int64_t endMicros) {
    ++sentCount_;
    lastEndMicros_ = endMicros;
  }

  uint16_t sentCount() const { return sentCount_; }
  int64_t durationMicros() const { return sentCount_ > 0 ? lastEndMicros_ - firstStartMicros_ : 0; }

private:
  bool started_ = false;
  uint16_t sentCount_ = 0;
  int64_t firstStartMicros_ = 0;
  int64_t lastEndMicros_ = 0;
};

} // namespace firmware

#endif
