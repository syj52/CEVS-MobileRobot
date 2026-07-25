/*
 * display_driver.h — MIPI DSI EK79007AD display driver for ESP32-P4
 *
 * Hardware:
 *   ESP32-P4-Function-EV-Board  J1 connector (MIPI DSI 2-lane)
 *   SubBoard:    ESP32-P4-HMI-SubBoard (J2 30-pin FPC)
 *   Driver IC:   EK79007AD + EK73217BCGA
 *   Resolution:  1024 × 600 (RGB565)
 *   Backlight:   GPIO (EN pin on subboard LED driver)
 *   Reset:       GPIO27
 *
 * Dependency:
 *   espressif/esp_lcd_ek79007 ^2.0.1
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ─── Panel specs (matches EK79007_1024_600_PANEL_60HZ_CONFIG) ──── */

#define DISPLAY_H_RES           1024
#define DISPLAY_V_RES           600
#define DISPLAY_BITS_PER_PIXEL  16    /* RGB565 */
#define DISPLAY_FB_BYTES        (DISPLAY_H_RES * DISPLAY_V_RES * 2)

/* ─── MIPI DSI PHY ───────────────────────────────────────────────── */

#define DISPLAY_MIPI_PHY_LDO_CHAN        3
#define DISPLAY_MIPI_PHY_LDO_VOLTAGE_MV  2500

/* ─── Opaque handle ─────────────────────────────────────────────── */

typedef struct display_context display_context_t;

/* ─── Public API ────────────────────────────────────────────────── */

/** Initialize display.  Shows DSI hardware color bars for 5 seconds,
 *  then switches to software-drawn green screen.
 *  Returns ESP_OK on success.  Non-fatal — system continues on failure. */
esp_err_t display_init(void);

/** Get internal context.  NULL if not initialized. */
display_context_t *display_get_context(void);

/** Backlight on/off.  duty > 0 = ON. */
esp_err_t display_set_backlight(uint8_t duty);

/** Fill entire screen with one RGB565 color (blocks until done). */
esp_err_t display_fill_color(uint16_t rgb565);

/** Draw RGB565 bitmap at (x, y), auto-clipped.  Blocks until done. */
esp_err_t display_draw_bitmap(int x, int y, int w, int h, const uint16_t *data);

/** Flush a full-screen RGB565 framebuffer. */
esp_err_t display_flush(const uint16_t *fb);

/** Get resolution (1024 × 600). */
void display_get_resolution(int *width, int *height);

/** Get direct pointer to the internal RGB565 framebuffer.
 *  Use with display_flush() to update the screen atomically. */
uint16_t *display_get_framebuffer(void);

/** Render occupancy-grid map.  mw×mh cells, data[row*col]=0..254.
 *  Caller must call display_flush_fb() after all overlays. */
esp_err_t display_render_map(int mw, int mh, const uint8_t *data);

/** Set map world coordinates (from MAP header) for pose conversion. */
void display_set_map_meta(float res, float ox, float oy);

/** Draw robot pose overlay (yellow circle + direction arrow).
 *  Requires display_render_map() to have been called first. */
esp_err_t display_render_pose(float rx_m, float ry_m, float angle_deg);

/** Draw navigation target marker (orange crosshair).
 *  Requires display_render_map() to have been called first. */
esp_err_t display_render_target(float tx_m, float ty_m);

/** Flush current framebuffer to panel. */
esp_err_t display_flush_fb(void);

/** True once panel is initialized. */
bool display_is_ready(void);

#ifdef __cplusplus
}
#endif
