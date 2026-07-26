/*
 * display_driver.c — MIPI DSI EK79007AD + GPIO backlight driver
 *
 * DSI link:  2-lane, 900 Mbps, 1024×600 @ 60 Hz
 * Panel IC:  EK79007AD (ESP32-P4-HMI-SubBoard, J2 30-pin FPC)
 * Backlight: GPIO simple HIGH — subboard has dedicated LED driver
 * Reset:     GPIO27
 *
 * After init, DSI hardware color bars appear for 5 seconds,
 * then switch to SW-drawn green screen — proving the full pipeline.
 */
#include <string.h>
#include <math.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_check.h"
#include "esp_ldo_regulator.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_mipi_dsi.h"
#include "esp_lcd_ek79007.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "display_driver.h"

static const char *TAG = "DISP";

struct display_context {
    esp_lcd_panel_handle_t   panel;
    esp_lcd_dsi_bus_handle_t dsi_bus;
    esp_lcd_panel_io_handle_t dbi_io;
    esp_ldo_channel_handle_t ldo_mipi_phy;
    SemaphoreHandle_t        refresh_done;
    uint16_t                *fb;        /* full-screen framebuffer (PSRAM) */
    bool                     hw_pattern_active;
    bool                     ready;
};

static display_context_t s_disp;

/* ── Last map transform (for pose overlay) ───────────────────── */
static int s_map_cs = 0, s_map_dx = 0, s_map_dy = 0;
static int s_map_mw = 0, s_map_mh = 0;
static float s_map_res = 0.05f, s_map_ox = 0, s_map_oy = 0;

/* ─── DPI refresh-done callback ─────────────────────────────────── */

static IRAM_ATTR bool on_refresh_done(esp_lcd_panel_handle_t panel,
                                       esp_lcd_dpi_panel_event_data_t *edata,
                                       void *user_ctx)
{
    (void)panel; (void)edata;
    BaseType_t need_yield = pdFALSE;
    xSemaphoreGiveFromISR((SemaphoreHandle_t)user_ctx, &need_yield);
    return (need_yield == pdTRUE);
}

static esp_err_t wait_refresh(void)
{
    if (!s_disp.refresh_done) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_disp.refresh_done, pdMS_TO_TICKS(1000)) != pdTRUE)
        return ESP_ERR_TIMEOUT;
    return ESP_OK;
}

/* ─── Ensure HW pattern is off before SW drawing ────────────────── */

static void ensure_sw_mode(void)
{
    if (s_disp.hw_pattern_active) {
        esp_lcd_dpi_panel_set_pattern(s_disp.panel, MIPI_DSI_PATTERN_NONE);
        vTaskDelay(pdMS_TO_TICKS(50));  /* let the DSI controller switch */
        s_disp.hw_pattern_active = false;
    }
}

/* ═══════════════════════════════════════════════════════════════════
 *  Panel init
 * ═══════════════════════════════════════════════════════════════════ */

static esp_err_t panel_create(display_context_t *ctx)
{
    /* 1. MIPI DSI PHY LDO */
    esp_ldo_channel_config_t ldo_cfg = {
        .chan_id = DISPLAY_MIPI_PHY_LDO_CHAN,
        .voltage_mv = DISPLAY_MIPI_PHY_LDO_VOLTAGE_MV,
    };
    ESP_RETURN_ON_ERROR(esp_ldo_acquire_channel(&ldo_cfg, &ctx->ldo_mipi_phy),
                        TAG, "PHY LDO");

    /* 2. DSI bus */
    esp_lcd_dsi_bus_config_t bus_cfg = EK79007_PANEL_BUS_DSI_2CH_CONFIG();
    ESP_RETURN_ON_ERROR(esp_lcd_new_dsi_bus(&bus_cfg, &ctx->dsi_bus), TAG, "DSI bus");

    /* 3. DBI IO */
    esp_lcd_dbi_io_config_t dbi_cfg = EK79007_PANEL_IO_DBI_CONFIG();
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_dbi(ctx->dsi_bus, &dbi_cfg, &ctx->dbi_io), TAG, "DBI IO");

    /* 4. DPI timing */
    esp_lcd_dpi_panel_config_t dpi = EK79007_1024_600_PANEL_60HZ_CONFIG(LCD_COLOR_PIXEL_FORMAT_RGB565);
    /* DMA2D conflicts with the JPEG encoder — disable it for the panel */
    dpi.flags.use_dma2d = false;

    /* 5. EK79007 vendor config */
    ek79007_vendor_config_t vendor = {
        .mipi_config = { .dsi_bus = ctx->dsi_bus, .dpi_config = &dpi, .lane_num = 2 },
    };
    const esp_lcd_panel_dev_config_t panel_cfg = {
        .reset_gpio_num = GPIO_NUM_27,
        .rgb_ele_order  = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = DISPLAY_BITS_PER_PIXEL,
        .vendor_config  = &vendor,
    };
    ESP_RETURN_ON_ERROR(esp_lcd_new_panel_ek79007(ctx->dbi_io, &panel_cfg, &ctx->panel), TAG, "panel create");

    /* 6. Reset + init */
    ESP_RETURN_ON_ERROR(esp_lcd_panel_reset(ctx->panel), TAG, "reset");
    ESP_RETURN_ON_ERROR(esp_lcd_panel_init(ctx->panel),  TAG, "init");

    /* 7. Refresh callback */
    ctx->refresh_done = xSemaphoreCreateBinary();
    if (!ctx->refresh_done) return ESP_ERR_NO_MEM;
    esp_lcd_dpi_panel_event_callbacks_t cbs = { .on_color_trans_done = on_refresh_done };
    ESP_RETURN_ON_ERROR(
        esp_lcd_dpi_panel_register_event_callbacks(ctx->panel, &cbs, ctx->refresh_done), TAG, "cb");
    xSemaphoreGive(ctx->refresh_done);

    /* 8. DSI ready — skip color bars, go straight to green */

    /* 9. Allocate full-screen framebuffer in PSRAM for SW drawing */
    ctx->fb = heap_caps_malloc(DISPLAY_FB_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!ctx->fb) {
        ESP_LOGW(TAG, "Framebuffer PSRAM failed — trying internal RAM");
        ctx->fb = heap_caps_malloc(DISPLAY_FB_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    }
    if (!ctx->fb) {
        ESP_LOGE(TAG, "Framebuffer OOM — SW drawing disabled");
        ctx->ready = true;   /* hardware pattern still works */
        return ESP_OK;
    }
    ESP_LOGI(TAG, "Framebuffer allocated: %d bytes", DISPLAY_FB_BYTES);

    ESP_LOGI(TAG, "EK79007 panel initialized");
    ctx->ready = true;
    return ESP_OK;
}

/* ═══════════════════════════════════════════════════════════════════
 *  Backlight — simple GPIO HIGH on all candidates
 *
 *  The HMI subboard has a dedicated LED driver (182 mA) with an
 *  EN (enable) pin.  Set all candidate backlight GPIOs HIGH.
 *  Only the actually connected one matters; the others are harmless.
 * ═══════════════════════════════════════════════════════════════════ */

static void backlight_on(void)
{
    const gpio_num_t pins[] = { GPIO_NUM_26, GPIO_NUM_22, GPIO_NUM_48 };
    for (int i = 0; i < sizeof(pins) / sizeof(pins[0]); i++) {
        gpio_config_t c = {
            .pin_bit_mask = BIT64(pins[i]),
            .mode         = GPIO_MODE_OUTPUT,
            .pull_up_en   = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type    = GPIO_INTR_DISABLE,
        };
        gpio_config(&c);
        gpio_set_level(pins[i], 1);
        ESP_LOGI(TAG, "Backlight GPIO%d → HIGH", pins[i]);
    }
}

/* ═══════════════════════════════════════════════════════════════════
 *  Public API
 * ═══════════════════════════════════════════════════════════════════ */

esp_err_t display_init(void)
{
    memset(&s_disp, 0, sizeof(s_disp));

    /* Backlight on first, so the user sees the color bars immediately */
    backlight_on();

    /* Panel */
    esp_err_t ret = panel_create(&s_disp);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Panel init failed: %s", esp_err_to_name(ret));
        return ret;
    }

    /* Turn off hardware pattern, fill dark gray (idle) */
    esp_lcd_dpi_panel_set_pattern(s_disp.panel, MIPI_DSI_PATTERN_NONE);
    s_disp.hw_pattern_active = false;
    vTaskDelay(pdMS_TO_TICKS(50));

    /* Dark gray idle screen — map render will overwrite when data arrives */
    if (s_disp.fb) {
        int total = DISPLAY_H_RES * DISPLAY_V_RES;
        for (int i = 0; i < total; i++) s_disp.fb[i] = 0x39E7;
        wait_refresh();
        esp_lcd_panel_draw_bitmap(s_disp.panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, s_disp.fb);
    }
    ESP_LOGI(TAG, "Init complete — waiting for map");

    return ESP_OK;
}

display_context_t *display_get_context(void) { return s_disp.ready ? &s_disp : NULL; }

esp_err_t display_set_backlight(uint8_t duty) { (void)duty; return ESP_OK; }

esp_err_t display_fill_color(uint16_t rgb565)
{
    if (!s_disp.ready) return ESP_ERR_INVALID_STATE;
    if (!s_disp.fb) return ESP_ERR_NO_MEM;
    ensure_sw_mode();

    /* Fill framebuffer with the solid color */
    int total = DISPLAY_H_RES * DISPLAY_V_RES;
    for (int i = 0; i < total; i++) {
        s_disp.fb[i] = rgb565;
        if ((i & 8191) == 8191) taskYIELD();  /* yield periodically */
    }

    ESP_RETURN_ON_ERROR(wait_refresh(), TAG, "wait");
    return esp_lcd_panel_draw_bitmap(
        s_disp.panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, s_disp.fb);
}

esp_err_t display_draw_bitmap(int x, int y, int w, int h, const uint16_t *data)
{
    if (!s_disp.ready) return ESP_ERR_INVALID_STATE;
    ensure_sw_mode();
    if (x < 0) { w += x; data += (-x); x = 0; }
    if (y < 0) { h += y; data += (-y) * w; y = 0; }
    if (x + w > DISPLAY_H_RES) w = DISPLAY_H_RES - x;
    if (y + h > DISPLAY_V_RES) h = DISPLAY_V_RES - y;
    if (w <= 0 || h <= 0) return ESP_OK;
    ESP_RETURN_ON_ERROR(wait_refresh(), TAG, "wait");
    return esp_lcd_panel_draw_bitmap(s_disp.panel, x, y, x + w, y + h, data);
}

esp_err_t display_flush(const uint16_t *fb)
{
    return display_draw_bitmap(0, 0, DISPLAY_H_RES, DISPLAY_V_RES, fb);
}

void display_get_resolution(int *w, int *h)
{
    if (w) *w = DISPLAY_H_RES;
    if (h) *h = DISPLAY_V_RES;
}

bool display_is_ready(void) { return s_disp.ready; }

uint16_t *display_get_framebuffer(void)
{
    return s_disp.ready ? s_disp.fb : NULL;
}

/* ─── Map rendering ───────────────────────────────────────────── */

esp_err_t display_render_map(int mw, int mh, const uint8_t *data)
{
    if (!s_disp.ready || !s_disp.fb) return ESP_ERR_INVALID_STATE;
    if (!data || mw < 1 || mh < 1) return ESP_ERR_INVALID_ARG;
    ensure_sw_mode();

    /* Scale map to fit display: use integer cell size, center the result */
    int cs = (DISPLAY_H_RES / mw < DISPLAY_V_RES / mh)
             ? DISPLAY_H_RES / mw : DISPLAY_V_RES / mh;
    if (cs < 1) cs = 1;
    if (cs > 16) cs = 16;   /* cap cell size for readability */

    int ox = (DISPLAY_H_RES - mw * cs) / 2;
    int oy = (DISPLAY_V_RES - mh * cs) / 2;

    /* Save transform for pose overlay */
    s_map_cs = cs; s_map_dx = ox; s_map_dy = oy;
    s_map_mw = mw; s_map_mh = mh;

    /* Fill border dark gray, cells from map data */
    int total = DISPLAY_H_RES * DISPLAY_V_RES;
    for (int i = 0; i < total; i++) s_disp.fb[i] = 0x39E7;

    for (int row = 0; row < mh; row++) {
        for (int col = 0; col < mw; col++) {
            uint8_t v = data[row * mw + col];
            uint16_t color;
            if (v == 0)           color = 0xFFFF;  /* occupied → white */
            else if (v >= 254)    color = 0x0000;  /* free      → black */
            else if (v >= 200)    color = 0x4208;  /* likely free → dark gray */
            else                  color = 0x8410;  /* unknown   → light gray */

            int py = oy + row * cs;
            int px = ox + col * cs;
            for (int dy = 0; dy < cs; dy++) {
                for (int dx = 0; dx < cs; dx++) {
                    s_disp.fb[(py + dy) * DISPLAY_H_RES + (px + dx)] = color;
                }
            }
        }
    }

    ESP_LOGI(TAG, "Map rendered: %dx%d cell=%d offset=(%d,%d)", mw, mh, cs, ox, oy);
    return ESP_OK;   /* caller flushes after overlays */
}

/* ─── Map meta (for pose coordinate conversion) ───────────────── */

void display_set_map_meta(float res, float ox, float oy) {
    s_map_res = res; s_map_ox = ox; s_map_oy = oy;
}

/* ─── Pose overlay ───────────────────────────────────────────── */

esp_err_t display_render_pose(float rx_m, float ry_m, float angle_deg)
{
    if (!s_disp.ready || !s_disp.fb) return ESP_ERR_INVALID_STATE;
    if (s_map_cs < 1) return ESP_ERR_INVALID_STATE;  /* map not rendered yet */

    /* World → pixel:  col = (x - ox) / res,   px = dx + col * cs
     * Y is flipped: PGM row 0 = top = highest world Y,
     *               PGM row h-1 = bottom = lowest world Y = oy */
    int px = s_map_dx + (int)((rx_m - s_map_ox) / s_map_res * (float)s_map_cs);
    int row = s_map_mh - 1 - (int)((ry_m - s_map_oy) / s_map_res);
    int py = s_map_dy + row * s_map_cs;

    /* Arrow direction — convert angle to unit vector */
    float rad = angle_deg * 3.14159f / 180.0f;
    int dx = (int)(cosf(rad) * (float)s_map_cs * 2.0f);   /* longer arrow */
    int dy = (int)(-sinf(rad) * (float)s_map_cs * 1.2f);

    /* Draw arrow: bright red filled circle + direction line */
    uint16_t body_color = 0xF800;   /* red — stands out on any background */
    uint16_t line_color = 0xFFE0;   /* yellow direction line */
    int r = s_map_cs >= 16 ? 16 : (s_map_cs >= 8 ? 10 : 8);  /* 2× larger */

    /* Body: filled red circle */
    for (int yd = -r; yd <= r; yd++) {
        for (int xd = -r; xd <= r; xd++) {
            if (xd*xd + yd*yd <= r*r) {
                int sx = px + xd, sy = py + yd;
                if (sx >= 0 && sx < DISPLAY_H_RES && sy >= 0 && sy < DISPLAY_V_RES)
                    s_disp.fb[sy * DISPLAY_H_RES + sx] = body_color;
            }
        }
    }

    /* Black outline ring for contrast */
    for (int yd = -r-1; yd <= r+1; yd++) {
        for (int xd = -r-1; xd <= r+1; xd++) {
            int d2 = xd*xd + yd*yd;
            if (d2 > r*r && d2 <= (r+1)*(r+1)) {
                int sx = px + xd, sy = py + yd;
                if (sx >= 0 && sx < DISPLAY_H_RES && sy >= 0 && sy < DISPLAY_V_RES)
                    s_disp.fb[sy * DISPLAY_H_RES + sx] = 0x0000;  /* black ring */
            }
        }
    }

    /* Direction line: single-pixel yellow Bresenham, clean at any angle */
    {
        int x0 = px + (int)(dx * 0.25f), y0 = py + (int)(dy * 0.25f);
        int x1 = px + dx, y1 = py + dy;
        int sx = (x0 < x1) ? 1 : -1, sy = (y0 < y1) ? 1 : -1;
        int ex = (x1 > x0) ? x1 - x0 : x0 - x1;
        int ey = (y1 > y0) ? y1 - y0 : y0 - y1;
        int err = ex - ey;
        while (1) {
            if (x0 >= 0 && x0 < DISPLAY_H_RES && y0 >= 0 && y0 < DISPLAY_V_RES)
                s_disp.fb[y0 * DISPLAY_H_RES + x0] = line_color;
            if (x0 == x1 && y0 == y1) break;
            int e2 = 2 * err;
            if (e2 > -ey) { err -= ey; x0 += sx; }
            if (e2 <  ex) { err += ex; y0 += sy; }
        }
    }

    ESP_LOGW(TAG, "Pose: (%.2f,%.2f)@%.0f° → px=%d py=%d",
             (double)rx_m, (double)ry_m, (double)angle_deg, px, py);
    return ESP_OK;
}

/* ─── Navigation target marker ───────────────────────────────── */

esp_err_t display_render_target(float tx_m, float ty_m)
{
    if (!s_disp.ready || !s_disp.fb) return ESP_ERR_INVALID_STATE;
    if (s_map_cs < 1) return ESP_ERR_INVALID_STATE;

    /* World → pixel (same transform as pose) */
    int px = s_map_dx + (int)((tx_m - s_map_ox) / s_map_res * (float)s_map_cs);
    int row = s_map_mh - 1 - (int)((ty_m - s_map_oy) / s_map_res);
    int py = s_map_dy + row * s_map_cs;

    int sz = s_map_cs >= 16 ? 14 : (s_map_cs >= 8 ? 10 : 7);  /* cross arm length */

    /* Clamp to screen */
    if (px < -sz || px >= DISPLAY_H_RES + sz || py < -sz || py >= DISPLAY_V_RES + sz)
        return ESP_OK;

    uint16_t color = 0xFD20;   /* orange/gold cross */

    /* Cross: horizontal line */
    for (int x = px - sz; x <= px + sz; x++) {
        if (x >= 0 && x < DISPLAY_H_RES && py >= 0 && py < DISPLAY_V_RES)
            s_disp.fb[py * DISPLAY_H_RES + x] = color;
    }
    /* Cross: vertical line */
    for (int y = py - sz; y <= py + sz; y++) {
        if (y >= 0 && y < DISPLAY_V_RES && px >= 0 && px < DISPLAY_H_RES)
            s_disp.fb[y * DISPLAY_H_RES + px] = color;
    }

    /* Black outline: single-pixel ring around the cross endpoints */
    uint16_t outline = 0x0000;
    int ends[4][2] = {{px - sz, py}, {px + sz, py}, {px, py - sz}, {px, py + sz}};
    for (int i = 0; i < 4; i++) {
        int ex = ends[i][0], ey = ends[i][1];
        for (int yd = -1; yd <= 1; yd++) {
            for (int xd = -1; xd <= 1; xd++) {
                if (xd == 0 && yd == 0) continue;
                int sx = ex + xd, sy = ey + yd;
                if (sx >= 0 && sx < DISPLAY_H_RES && sy >= 0 && sy < DISPLAY_V_RES)
                    s_disp.fb[sy * DISPLAY_H_RES + sx] = outline;
            }
        }
    }

    ESP_LOGW(TAG, "Target: (%.2f,%.2f) → px=%d py=%d",
             (double)tx_m, (double)ty_m, px, py);
    return ESP_OK;
}

/* ─── QR code rendering ───────────────────────────────────── */

#include "qrcodegen.h"

esp_err_t display_render_qr(const char *url, int module_px, int margin_px)
static esp_err_t display_render_qr_bitmap(const uint8_t qrcode[], int size, int module_px, int margin_px);
{
    if (!s_disp.ready || !s_disp.fb) return ESP_ERR_INVALID_STATE;
    if (!url || !*url) return ESP_ERR_INVALID_ARG;

    /* Generate QR code (version 2 = 25x25 modules) */
    uint8_t qr[qrcodegen_BUFFER_LEN_FOR_VERSION(2)];
    uint8_t tmp[qrcodegen_BUFFER_LEN_FOR_VERSION(2)];
    if (!qrcodegen_encodeText(url, tmp, qr, qrcodegen_Ecc_LOW,
            qrcodegen_VERSION_MIN, 2, qrcodegen_Mask_AUTO, true)) {
        ESP_LOGW(TAG, "QR encode failed (URL too long?), trying version 3");
        uint8_t qr3[qrcodegen_BUFFER_LEN_FOR_VERSION(3)];
        uint8_t tmp3[qrcodegen_BUFFER_LEN_FOR_VERSION(3)];
        if (!qrcodegen_encodeText(url, tmp3, qr3, qrcodegen_Ecc_LOW,
                qrcodegen_VERSION_MIN, 3, qrcodegen_Mask_AUTO, true)) {
            ESP_LOGE(TAG, "QR encode failed for: %s", url);
            return ESP_FAIL;
        }
        return display_render_qr_bitmap(qr3, qrcodegen_getSize(qr3), module_px, margin_px);
    }
    return display_render_qr_bitmap(qr, qrcodegen_getSize(qr), module_px, margin_px);
}

static esp_err_t display_render_qr_bitmap(const uint8_t qrcode[], int size, int module_px, int margin_px)
{
    int qr_dim = (size + 2 * margin_px) * module_px;
    int ox = DISPLAY_H_RES - qr_dim - 8;   /* right-aligned, 8px edge margin */
    int oy = 8;                              /* top-aligned */

    for (int my = 0; my < size + 2 * margin_px; my++) {
        for (int mx = 0; mx < size + 2 * margin_px; mx++) {
            bool white;
            if (my < margin_px || my >= size + margin_px ||
                mx < margin_px || mx >= size + margin_px) {
                white = true;   /* quiet zone */
            } else {
                int y = my - margin_px;
                int x = mx - margin_px;
                white = (qrcodegen_getModule(qrcode, x, y) == 0);
            }
            uint16_t color = white ? 0xFFFF : 0x0000;  /* white or black */
            int px = ox + mx * module_px;
            int py = oy + my * module_px;
            for (int dy = 0; dy < module_px; dy++) {
                for (int dx = 0; dx < module_px; dx++) {
                    int sx = px + dx, sy = py + dy;
                    if (sx >= 0 && sx < DISPLAY_H_RES && sy >= 0 && sy < DISPLAY_V_RES)
                        s_disp.fb[sy * DISPLAY_H_RES + sx] = color;
                }
            }
        }
    }
    ESP_LOGI(TAG, "QR rendered: size=%d module=%d (%d×%d px) @(%d,%d)",
             size, module_px, qr_dim, qr_dim, ox, oy);
    return ESP_OK;
}

/* ─── Flush framebuffer to panel ─────────────────────────────── */

esp_err_t display_flush_fb(void)
{
    if (!s_disp.ready || !s_disp.fb) return ESP_ERR_INVALID_STATE;
    ESP_RETURN_ON_ERROR(wait_refresh(), TAG, "wait");
    return esp_lcd_panel_draw_bitmap(
        s_disp.panel, 0, 0, DISPLAY_H_RES, DISPLAY_V_RES, s_disp.fb);
}
