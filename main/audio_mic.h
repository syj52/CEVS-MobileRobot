#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include "esp_err.h"

#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_BITS          16
#define AUDIO_CHANNELS      1
#define AUDIO_BLOCK_MS      200                          /* 200ms per audio block */
#define AUDIO_BLOCK_BYTES   (AUDIO_SAMPLE_RATE * AUDIO_BLOCK_MS / 1000 * AUDIO_BITS / 8 * AUDIO_CHANNELS)

esp_err_t audio_mic_init(void);
esp_err_t audio_mic_deinit(void);

/* Access the latest audio block (for HTTP serving) */
const int16_t *audio_mic_get_latest_block(size_t *len);

bool audio_mic_is_ready(void);

/* VAD + voice segment: called when a complete utterance is detected.
 * Returns pointer to PSRAM buffer + length in bytes (PCM mono 16-bit).
 * Caller must NOT free; buffer will be overwritten on next utterance. */
const uint8_t *audio_mic_get_voice_segment(size_t *len);
void audio_mic_clear_voice_segment(void);
