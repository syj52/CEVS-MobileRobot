#pragma once
#include <stdint.h>
#include <stddef.h>
#include "esp_err.h"

/* Sample rate / format must match audio_mic (16kHz 16-bit mono) */

esp_err_t audio_spk_init(void);
esp_err_t audio_spk_deinit(void);

/* Play raw PCM data (16kHz 16-bit mono, ~6400 bytes = 200ms per block).
 * Copies data internally; caller may free immediately after return.
 * Returns ESP_OK if queued, ESP_ERR_NO_MEM if buffer full. */
esp_err_t audio_spk_play(const uint8_t *pcm, size_t len);

/* True if speaker is currently playing back audio */
bool audio_spk_is_playing(void);

/* Stop playback and clear buffer */
void audio_spk_stop(void);
