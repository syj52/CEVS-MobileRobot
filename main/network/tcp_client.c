#include <string.h>
#include <math.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <netdb.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "lwip/netdb.h"
#include "esp_random.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "tcp_client.h"
#include "nav/nav_grid.h"
#include <math.h>
#include "motion.h"
#include "uart_stm32.h"
#include "audio_spk.h"

static const char *TAG = "tcp_client";
static SemaphoreHandle_t s_send_mux = NULL;  /* protect against concurrent sends */

#define RECONNECT_DELAY_MS   2000
#define RECONNECT_MAX_DELAY  60000
#define READ_BUF_SIZE        512

static const char *s_host;
static uint16_t   s_port;
static bool       s_connected = false;
static int        s_sock     = -1;
static TaskHandle_t s_task_handle;

/* ─── Diagnostics: connection tracking ──────────────────────── */
static int  s_connect_count = 0;       /* total successful connects */
static TickType_t s_connect_tick = 0;  /* time of last connect */

#define LINE_BUF_SIZE 2048
static char s_line_buf[LINE_BUF_SIZE];
static int s_line_len = 0;

/* ─── MAP 接收状态机 ─────────────────────────────────────────── */
typedef enum {
    TCP_PARSE_LINE,   /* 默认：逐行解析 */
    TCP_RECV_BINARY,  /* 正在接收地图像素流 */
} tcp_recv_state_t;

static tcp_recv_state_t s_tcp_recv_state = TCP_PARSE_LINE;
static bool             s_map_in_progress = false; /* 独立标记：当前是否在接收地图过程中 */
/* TTS audio binary reception */
static int  s_tts_need = 0;
static int  s_tts_recv = 0;
static uint8_t *s_tts_buf = NULL;
static int             s_map_w = 0, s_map_h = 0;
static int             s_map_recv = 0;   /* 已接收的像素字节数 */

typedef enum {
    ESP_IDLE,
    ESP_MOVING,
} esp_state_t;

static esp_state_t s_esp_state = ESP_IDLE;

static void tcp_client_task(void *arg);

esp_err_t tcp_client_init(const char *host, uint16_t port)
{
    if (!host || port == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    s_host = host;
    s_port = port;
    s_send_mux = xSemaphoreCreateMutex();
    if (!s_send_mux) return ESP_ERR_NO_MEM;
    ESP_LOGI(TAG, "Configured target: %s:%d", host, port);
    return ESP_OK;
}

static int connect_retry(const char *host, uint16_t port)
{
    struct addrinfo hints = {
        .ai_family   = AF_INET,
        .ai_socktype = SOCK_STREAM,
    };
    struct addrinfo *res = NULL;
    char port_str[8] = {0};
    snprintf(port_str, sizeof(port_str), "%d", port);

    int err = getaddrinfo(host, port_str, &hints, &res);
    if (err != 0 || res == NULL) {
        ESP_LOGW(TAG, "DNS lookup failed: err=%d", err);
        return -1;
    }

    int sock = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket() failed");
        freeaddrinfo(res);
        return -1;
    }

    if (connect(sock, res->ai_addr, res->ai_addrlen) != 0) {
        ESP_LOGW(TAG, "connect() to %s:%d failed", host, port);
        close(sock);
        freeaddrinfo(res);
        return -1;
    }

    /* Send timeout: if a send() blocks longer than this, the link has
     * stalled (esp_hosted SDIO/WiFi congestion). We treat it as a broken
     * connection and reconnect, rather than deadlocking the video pipeline. */
    struct timeval snd_to = { .tv_sec = 2, .tv_usec = 0 };
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &snd_to, sizeof(snd_to));

    /* TCP keepalive: detect half-broken connections where our send()
     * succeeds (lwIP buffers it) but the data never reaches the server.
     * With 3 probes at 3s intervals, a dead link is detected in ~9s. */
    int keepalive = 1;
    setsockopt(sock, SOL_SOCKET, SO_KEEPALIVE, &keepalive, sizeof(keepalive));
    int keepidle = 3;     /* start probing after 3s idle */
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPIDLE, &keepidle, sizeof(keepidle));
    int keepintvl = 3;    /* 3s between probes */
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPINTVL, &keepintvl, sizeof(keepintvl));
    int keepcnt = 3;      /* 3 failures = dead */
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPCNT, &keepcnt, sizeof(keepcnt));

    /* Disable Nagle so JPEG frames go out immediately (lower latency) */
    int one = 1;
    setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    freeaddrinfo(res);
    ESP_LOGI(TAG, "Connected to %s:%d, sock=%d (2s send timeout, nodelay)", host, port, sock);
    return sock;
}

static float kv_get_float(const char *buf, const char *key, float default_val)
{
    char pattern[48];
    snprintf(pattern, sizeof(pattern), "%s=", key);
    char *p = strstr(buf, pattern);
    if (!p) return default_val;
    p += strlen(pattern);
    char *end;
    float v = strtof(p, &end);
    return (end == p) ? default_val : v;
}

/* ─── Navigation — real motor control via UART STM32 ─────── */

/* ─── MAP 行解析 ─────────────────────────────────────────────── */

static void handle_map_meta(const char *line)
{
    /* 格式: MAP:W=<w>,H=<h>,R=<res>,OX=<ox>,OY=<oy> */
    int w = 0, h = 0;
    float r = 0.0f, ox = 0.0f, oy = 0.0f;

    if (sscanf(line, "MAP:W=%d,H=%d,R=%f,OX=%f,OY=%f",
               &w, &h, &r, &ox, &oy) != 5) {
        ESP_LOGE(TAG, "handle_map_meta: parse failed: %s", line);
        return;
    }

    grid_map_init(w, h, r, ox, oy);
/* Reject if total pixels overflow the grid buffer */
	if ((int64_t)w * h > MAP_MAX_W * MAP_MAX_H) {
		ESP_LOGE(TAG, "MAP %dx%d exceeds %dx%d limit", w, h, MAP_MAX_W, MAP_MAX_H);
		s_tcp_recv_state = TCP_PARSE_LINE;
		return;
	}
    s_map_w          = w;
    s_map_h          = h;
    s_map_recv       = 0;
    s_map_in_progress = true;
    s_tcp_recv_state = TCP_RECV_BINARY;
    ESP_LOGI(TAG, "MAP header parsed: %dx%d res=%.3f  → switching to BINARY",
             w, h, r);
}

static void handle_map_end(void)
{
    if (!s_map_in_progress) {
        ESP_LOGW(TAG, "MAP:END without active MAP header, ignored");
        return;
    }

    if (s_map_recv != s_map_w * s_map_h) {
        ESP_LOGE(TAG, "MAP:END but recv %d != expected %d",
                 s_map_recv, s_map_w * s_map_h);
        s_map_in_progress = false;
        s_tcp_recv_state = TCP_PARSE_LINE;
        return;
    }

    g_grid_map.valid   = true;
    s_map_in_progress  = false;
    s_tcp_recv_state   = TCP_PARSE_LINE;
    ESP_LOGI(TAG, "handle_map_end: about to send ACK:MAP");
    tcp_client_send_raw("ACK:MAP\r\n", 9);
    ESP_LOGI(TAG, "MAP received (%dx%d), ACK sent", s_map_w, s_map_h);
}


/* ─── Command dispatch ─────────────────────────────────────── */

static void dispatch_cmd(const char *line)
{
    /* CMD:NAV needs the full line (ca=, cy=, last= are past 64 chars) */
    if (memcmp(line, "CMD:NAV:", 8) == 0) {
        /* Parse from the full line */
        float tx = kv_get_float(line, "tx", -999);
        float ty = kv_get_float(line, "ty", -999);
        if (tx == -999 || ty == -999) {
            tx = kv_get_float(line, "x", -999);
            ty = kv_get_float(line, "y", -999);
        }
        if (tx == -999 || ty == -999) {
            tcp_client_send_raw("ERR:INVALID_NAV\r\n", 18);
            return;
        }
        // Map validation disabled — small scene with known shelf positions
        motion_tick();  /* fresh sensor reading before computing plan */
        const robot_pose_t *p = motion_get_pose();
        float dx = tx - p->x_m, dy = ty - p->y_m;
        float tgt = atan2f(dy, dx) * 180.0f / 3.14159f;
        float dlt = delta_deg(p->angle_deg, tgt);
        float dst = sqrtf(dx * dx + dy * dy);
        {
            char buf[80];
            int len = snprintf(buf, sizeof(buf), "NAV:PLAN:dlt=%.1f,dst=%.3f\r\n",
                               (double)dlt, (double)dst);
            tcp_client_send_raw(buf, len);
        }
        s_esp_state = ESP_MOVING;
        tcp_client_send_raw("EXEC:S\r\n", 8);
        motion_nav_to_pose(tx, ty, p->x_m, p->y_m, p->angle_deg);
        return;
    }

    /* s_line_buf is a static buffer that may have leftover data.
       Strip the string at the first non-printable char so old '\0'
       at a later position can't confuse strcmp. */
    char tmp[64];
    int n = 0;
    while (n < (int)sizeof(tmp) - 1 && line[n] >= 0x20 && line[n] < 0x7F) n++;
    memcpy(tmp, line, n);
    tmp[n] = '\0';
    line = tmp;
    /* MAP 指令（不在 CMD: 前缀下） */
    if (memcmp(line, "MAP:W=", 6) == 0) {
        handle_map_meta(line);
        return;
    }
    if (strcmp(line, "MAP:END") == 0) {
        handle_map_end();
        return;
    }

    /* ACK:MAP 是 ESP 主动发给 Server 的确认消息，不走 CMD: 前缀约束，
       也不走任何命令分发 —— 直接在 handle_map_end() 里处理，不应在此重复发 ACK */
    if (strcmp(line, "ACK:MAP") == 0) {
        ESP_LOGD(TAG, "ACK:MAP (ignored in dispatch, already sent by handle_map_end)");
        return;
    }

    /* !NAV: frame — forward to STM32 via UART (new closed-loop nav protocol) */
    if (line[0] == '!') {
        uart_stm32_send(line);
        return;
    }

    /* TTS audio playback — $TTS:<len> followed by PCM data */
    if (memcmp(line, "$TTS:", 5) == 0) {
        int len = atoi(line + 5);
        if (len > 0 && len < 256 * 1024) {  /* max 256KB PCM (~8s) */
            s_tts_need = len;
            s_tts_recv = 0;
            /* Allocate in PSRAM for large buffers */
            free(s_tts_buf);
            s_tts_buf = heap_caps_malloc(len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            if (!s_tts_buf) {
                s_tts_need = 0;
                ESP_LOGE(TAG, "TTS OOM for %d bytes", len);
            } else {
                ESP_LOGI(TAG, "TTS incoming: %d bytes PCM", len);
            }
        }
        return;
    }

    /* Manual motor frame — STOP unless spin field is set (dir=0,spin=1|2) */
    if (line[0] == '$') {
        if (line[1] == '0' && !(line[3] == '1' || line[3] == '2')) {
            motion_stop();                /* real stop: dir=0 and no spin */
        } else {
            motion_send_raw(line);
        }
        return;
    }

    if (memcmp(line, "CMD:", 4) != 0) {
        tcp_client_send_raw("ERR:EXPECTED_CMD\r\n", 19);
        return;
    }

    const char *cmd = line + 4;

    if (strcmp(cmd, "PING") == 0) {
        tcp_client_send_raw("OK:PING\r\n", 9);
        return;
    }

    /* 诊断：CMD:TONE=<freq>,<dur_ms>,<amp> — 通过 audio_spk_play 路径播放正弦波 */
    if (memcmp(cmd, "TONE=", 5) == 0) {
        int freq = 1000, dur = 500, amp = 10000;
        sscanf(cmd + 5, "%d,%d,%d", &freq, &dur, &amp);
        if (amp > 32767) amp = 32767;
        if (amp < 1) amp = 1;
        /* 生成 mono PCM 并走 audio_spk_play（含 stereo 扩展 + ring buffer） */
        int n_samples = 16000 * dur / 1000;
        size_t mono_len = n_samples * 2;
        uint8_t *buf = heap_caps_malloc(mono_len, MALLOC_CAP_8BIT);
        if (buf) {
            for (int i = 0; i < n_samples; i++) {
                ((int16_t *)buf)[i] = (int16_t)(amp * sinf(2 * 3.14159f * freq * i / 16000));
            }
            esp_err_t r = audio_spk_play(buf, mono_len);
            ESP_LOGI(TAG, "TONE via audio_spk_play: %dHz %dms amp=%d → %s",
                     freq, dur, amp, r == ESP_OK ? "OK" : "FAIL");
            free(buf);
        }
        tcp_client_send_raw("OK:TONE\r\n", 9);
        return;
    }

    if (strcmp(cmd, "STOP") == 0) {
        motion_stop();
        s_esp_state = ESP_IDLE;
        /* Always report current pose on STOP — for nav abort recovery */
        {
            const robot_pose_t *p = motion_get_pose();
            char buf[96];
            int len = snprintf(buf, sizeof(buf), "$POSE:x=%.3f,y=%.3f,a=%.1f\r\n",
                               (double)p->x_m, (double)p->y_m, (double)p->angle_deg);
            tcp_client_send_raw(buf, len);
        }
        tcp_client_send_raw("EXEC:S\r\n", 8);
        ESP_LOGI(TAG, "Stopped");
        return;
    }

    if (memcmp(cmd, "SPIN:", 5) == 0) {
        int dir = cmd[5] - '0';   /* 3=CCW, 4=CW */
        if (dir == 3 || dir == 4) {
            motion_spin(dir);
            s_esp_state = ESP_MOVING;
            tcp_client_send_raw("EXEC:S\r\n", 8);
            ESP_LOGI(TAG, "Spinning dir=%d", dir);
        }
        return;
    }

    if (memcmp(cmd, "POS:", 4) == 0) {
        float px = kv_get_float(line, "x", 0);
        float py = kv_get_float(line, "y", 0);
        float pa = kv_get_float(line, "a", 0);
        motion_set_pose(px, py, pa);
        ESP_LOGI(TAG, "Pos update: (%.2f,%.2f)@%.1f°", (double)px, (double)py, (double)pa);
        return;
    }

    tcp_client_send_raw("ERR:UNKNOWN_CMD\r\n", 17);
}

/* ─── TCP client task ─────────────────────────────────────── */

static void tcp_client_task(void *arg)
{
    (void)arg;
    int delay_ms = RECONNECT_DELAY_MS;
    char read_buf[READ_BUF_SIZE];

    while (1) {
        if (s_sock < 0) {
            s_sock = connect_retry(s_host, s_port);
            if (s_sock < 0) {
                ESP_LOGI(TAG, "Retrying in %d ms...", delay_ms);
                vTaskDelay(pdMS_TO_TICKS(delay_ms));
                delay_ms = (delay_ms * 2 > RECONNECT_MAX_DELAY)
                           ? RECONNECT_MAX_DELAY : delay_ms * 2;
                continue;
            }
            delay_ms = RECONNECT_DELAY_MS;
            s_connected = true;
            s_connect_count++;
            s_connect_tick = xTaskGetTickCount();
            ESP_LOGW(TAG, "Connected (#%d, sock=%d)", s_connect_count, s_sock);
        }

        fd_set readset;
        FD_ZERO(&readset);
        FD_SET(s_sock, &readset);
        struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };

        int n = select(s_sock + 1, &readset, NULL, NULL, &tv);
        if (n < 0) {
            ESP_LOGW(TAG, "select error, reconnecting");
            close(s_sock);
            s_sock = -1;
            s_connected = false;
            continue;
        }
        if (n == 0) {
            continue;
        }

        int len = recv(s_sock, read_buf, sizeof(read_buf) - 1, 0);
        if (len <= 0) {
            ESP_LOGW(TAG, "recv() returned %d, reconnecting", len);
            close(s_sock);
            s_sock = -1;
            s_connected = false;
            continue;
        }

        if ((size_t)(s_line_len + len) >= LINE_BUF_SIZE) {
            ESP_LOGW(TAG, "line buffer overflow, clearing");
            s_line_len = 0;
        }

        memcpy(s_line_buf + s_line_len, read_buf, len);
        s_line_len += len;

        /* ── BINARY 模式：直接写入地图像素 ── */
        if (s_tcp_recv_state == TCP_RECV_BINARY) {
            int need = s_map_w * s_map_h - s_map_recv;
            int can  = (int)len < need ? (int)len : need;
            memcpy(g_grid_map.data + s_map_recv, read_buf, can);
            s_map_recv += can;
            ESP_LOGI(TAG, "BINARY: recv=%d can=%d", s_map_recv, can);

            if (s_map_recv >= s_map_w * s_map_h) {
                ESP_LOGI(TAG, "BINARY: map full, rest=%d", len - can);
                /* 地图已收满，检查本批次剩余字节中是否已有 MAP:END */
                int rest = (int)len - can;          // "MAP:END\r\n" 共 9 字节
                bool inline_handled = false;

                if (rest > 0) {
                    int start = can;  // read_buf 中地图数据结束位置
                    // 在剩余字节中找 "\n"，向前回退 "\r"
                    for (int i = start; i < (int)len; i++) {
                        if (read_buf[i] == '\n') {
                            ESP_LOGI(TAG, "BINARY: found \\n at i=%d", i);
                            int line_end   = i;   // 含 \n
                            int line_start = start;  // map 数据边界，不回退 map 内容
                            int line_len   = line_end - line_start;  // 含 \r 不含 \n
                            ESP_LOGI(TAG, "BINARY: line_start=%d line_len=%d", line_start, line_len);
                            if (line_len > 0) {
                                memcpy(s_line_buf, read_buf + line_start, line_len);
                                s_line_buf[line_len] = '\0';
                                ESP_LOGI(TAG, "recv: %s", s_line_buf);
                                ESP_LOGI(TAG, "BINARY: calling dispatch_cmd");
                                dispatch_cmd(s_line_buf);
                                ESP_LOGI(TAG, "BINARY: dispatch_cmd returned");
                            }
                            // 保留此 \n 之后的部分（正常情况应该没有，但保险起见）
                            int after = (int)len - line_end - 1;
                            s_line_len = 0;
                            if (after > 0 && (size_t)(s_line_len + after) < LINE_BUF_SIZE) {
                                memcpy(s_line_buf, read_buf + line_end + 1, after);
                                s_line_len = after;
                            }
                            inline_handled = true;
                            break;
                        }
                    }
                }

                s_tcp_recv_state = TCP_PARSE_LINE;
                if (!inline_handled) {
                    /* 本次 recv 没有 MAP:END，清空行缓冲，等待下一次 recv() */
                    s_line_len = 0;
                }
            } else {
                s_line_len = 0;
            }
        }

        /* ── TTS 二进制数据接收 ── */
        if (s_tts_need > 0 && s_tts_buf) {
            /* 只用 s_line_buf（已累积了所有 recv 数据，见上文的 memcpy）。
               绝不用 read_buf —— 它和 s_line_buf 里的是同一份数据，
               同时处理两份会导致 PCM 数据被重复计数，s_tts_recv 提前达标，
               实际 PCM 只收了一半就开始播放 ⇒ 杂音。 */
            if (s_line_len > 0) {
                int can = s_tts_need - s_tts_recv;
                if (can > s_line_len) can = s_line_len;
                memcpy(s_tts_buf + s_tts_recv, s_line_buf, can);
                s_tts_recv += can;
                memmove(s_line_buf, s_line_buf + can, s_line_len - can);
                s_line_len -= can;
            }
            /* TTS 数据在 s_line_buf 里处理完了，不让 LINE 解析器再碰 */
            len = 0;
            if (s_tts_recv >= s_tts_need) {
                ESP_LOGI(TAG, "TTS received %d bytes, playing...", s_tts_recv);
                /* ██ 诊断：检查 PCM 数据有效性 ██ */
                {
                    int16_t *smp = (int16_t *)s_tts_buf;
                    int n = s_tts_recv / 2;
                    int16_t vmin = 32767, vmax = -32768;
                    int64_t sum = 0;
                    for (int j = 0; j < n && j < 500; j++) {
                        int16_t v = smp[j];
                        if (v < vmin) vmin = v;
                        if (v > vmax) vmax = v;
                        sum += (v < 0 ? -v : v);
                    }
                    ESP_LOGI(TAG, "PCM: %d samples, min=%d max=%d avg(|x|)=%lld, first16=[%04x %04x %04x %04x %04x %04x %04x %04x]",
                             n, vmin, vmax, (long long)(sum / (n < 500 ? n : 500)),
                             (uint16_t)smp[0], (uint16_t)smp[1], (uint16_t)smp[2], (uint16_t)smp[3],
                             (uint16_t)smp[4], (uint16_t)smp[5], (uint16_t)smp[6], (uint16_t)smp[7]);
                }
                if (audio_spk_play(s_tts_buf, s_tts_recv) != ESP_OK) {
                    ESP_LOGE(TAG, "TTS play buffer full, reconnecting");
                    close(s_sock); s_sock = -1; s_connected = false;
                }
                free(s_tts_buf); s_tts_buf = NULL;
                s_tts_need = 0; s_tts_recv = 0;
                s_line_len = 0;
            }
        }

        /* ── LINE 模式：按 \n 切分行 ── */
        while (s_tcp_recv_state == TCP_PARSE_LINE && len > 0) {
            int processed = 0;
            for (int i = 0; i < s_line_len; i++) {
                if (s_line_buf[i] == '\n') {
                    processed = i + 1;
                    int line_len = i;
                    if (line_len > 0 && s_line_buf[line_len - 1] == '\r') {
                        line_len--;
                    }
                    if (line_len > 0) {
                        s_line_buf[line_len] = '\0';
                        /* TTS PCM 数据不打印（二进制乱码） */
                        if (s_tts_need == 0) ESP_LOGI(TAG, "recv: %s", s_line_buf);
                        dispatch_cmd(s_line_buf);
                        /* $TTS: 后紧跟 PCM，立即退出行解析 */
                        if (s_tts_need > 0) {
                            if (s_line_len > processed) {
                                memmove(s_line_buf, s_line_buf + processed, s_line_len - processed);
                                s_line_len -= processed;
                            } else { s_line_len = 0; }
                            goto tts_drain;
                        }
                    }
                    break;
                }
            }
            if (processed > 0) {
                memmove(s_line_buf, s_line_buf + processed, s_line_len - processed);
                s_line_len -= processed;
            } else {
                break;
            }
        }
tts_drain:
        /* 立即排空 s_line_buf 中残留的 PCM 数据（$TTS: 头之后的部分） */
        if (s_tts_need > 0 && s_tts_buf && s_line_len > 0) {
            int can = s_tts_need - s_tts_recv;
            if (can > s_line_len) can = s_line_len;
            memcpy(s_tts_buf + s_tts_recv, s_line_buf, can);
            s_tts_recv += can;
            memmove(s_line_buf, s_line_buf + can, s_line_len - can);
            s_line_len -= can;
            if (s_tts_recv >= s_tts_need) {
                ESP_LOGI(TAG, "TTS received %d bytes, playing...", s_tts_recv);
                /* ██ 诊断：检查 PCM 数据有效性 ██ */
                {
                    int16_t *smp = (int16_t *)s_tts_buf;
                    int n = s_tts_recv / 2;
                    int16_t vmin = 32767, vmax = -32768;
                    int64_t sum = 0;
                    for (int j = 0; j < n && j < 500; j++) {
                        int16_t v = smp[j];
                        if (v < vmin) vmin = v;
                        if (v > vmax) vmax = v;
                        sum += (v < 0 ? -v : v);
                    }
                    ESP_LOGI(TAG, "PCM: %d samples, min=%d max=%d avg(|x|)=%lld, first16=[%04x %04x %04x %04x %04x %04x %04x %04x]",
                             n, vmin, vmax, (long long)(sum / (n < 500 ? n : 500)),
                             (uint16_t)smp[0], (uint16_t)smp[1], (uint16_t)smp[2], (uint16_t)smp[3],
                             (uint16_t)smp[4], (uint16_t)smp[5], (uint16_t)smp[6], (uint16_t)smp[7]);
                }
                if (audio_spk_play(s_tts_buf, s_tts_recv) != ESP_OK) {
                    ESP_LOGE(TAG, "TTS play buffer full, reconnecting");
                    close(s_sock); s_sock = -1; s_connected = false;
                }
                free(s_tts_buf); s_tts_buf = NULL;
                s_tts_need = 0; s_tts_recv = 0;
                s_line_len = 0;
            }
        }

        /* If line mode switched to binary, process remaining buffered data */
        if (s_tcp_recv_state == TCP_RECV_BINARY) {
            int need = s_map_w * s_map_h - s_map_recv;
            if (need > 0 && s_line_len > 0) {
                int can = s_line_len < need ? s_line_len : need;
                memcpy(g_grid_map.data + s_map_recv, s_line_buf, can);
                s_map_recv += can;
                memmove(s_line_buf, s_line_buf + can, s_line_len - can);
                s_line_len -= can;
                ESP_LOGI(TAG, "BINARY(buffered): recv=%d/%d", s_map_recv, s_map_w * s_map_h);

                if (s_map_recv >= s_map_w * s_map_h) {
                    for (int i = 0; i < s_line_len; i++) {
                        if (s_line_buf[i] == '\n') {
                            int end_len = i;
                            if (end_len > 0 && s_line_buf[end_len - 1] == '\r') end_len--;
                            if (end_len > 0) { s_line_buf[end_len] = '\0'; dispatch_cmd(s_line_buf); }
                            memmove(s_line_buf, s_line_buf + i + 1, s_line_len - i - 1);
                            s_line_len -= i + 1;
                            break;
                        }
                    }
                }
            }
        }
    }
}

esp_err_t tcp_client_start(void)
{
    BaseType_t ret = xTaskCreatePinnedToCore(
        tcp_client_task,
        "tcp_client",
        8192,
        NULL,
        tskIDLE_PRIORITY + 3,
        &s_task_handle,
        0 /* pinned to CPU0 */
    );
    if (ret != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        return ESP_FAIL;
    }
    ESP_LOGI(TAG, "Task started");
    return ESP_OK;
}

bool tcp_client_is_connected(void)
{
    return s_connected;
}

void tcp_client_send(const char *data)
{
    /* STM32 data only (<200 B lines). No mutex: video's large binary frames
     * already hold s_send_mux for hundreds of ms, and STM32 telemetry can't
     * wait that long.  send() on a TCP socket of <200 bytes is atomic at
     * the TCP segment level, and the server parses by '\n' so partial lines
     * recover on the next recv(). */
    if (s_sock >= 0 && data) {
        send(s_sock, data, strlen(data), 0);
    }
}

void tcp_client_send_raw(const char *data, int len)
{
    if (s_sock >= 0 && data && len > 0 && s_send_mux) {
        xSemaphoreTake(s_send_mux, portMAX_DELAY);
        send(s_sock, data, len, 0);
        xSemaphoreGive(s_send_mux);
    }
}

void tcp_client_send_binary(const char *hdr, int hlen, const char *body, int blen)
{
    if (s_sock < 0 || !hdr || hlen <= 0 || !body || blen <= 0 || !s_send_mux) return;

    xSemaphoreTake(s_send_mux, portMAX_DELAY);
    int fd = s_sock;
    if (fd < 0) { xSemaphoreGive(s_send_mux); return; }

    /* Send header */
    int sent = 0;
    while (sent < hlen) {
        int n = send(fd, hdr + sent, hlen - sent, 0);
        if (n <= 0) {
            /* Send failed/timed out → connection stalled. The TCP stream is
             * now misaligned (partial frame). Force a reconnect so both sides
             * reset their framing, instead of deadlocking the video pipeline. */
            ESP_LOGW(TAG, "send hdr failed (n=%d errno=%d) → reconnect", n, errno);
            shutdown(fd, SHUT_RDWR);
            close(s_sock);
            s_sock = -1;
            s_connected = false;
            xSemaphoreGive(s_send_mux);
            return;
        }
        sent += n;
    }
    /* Send body */
    sent = 0;
    while (sent < blen) {
        int n = send(fd, body + sent, blen - sent, 0);
        if (n <= 0) {
            ESP_LOGW(TAG, "send body failed at %d/%d (errno=%d) → reconnect", sent, blen, errno);
            shutdown(fd, SHUT_RDWR);
            close(s_sock);
            s_sock = -1;
            s_connected = false;
            xSemaphoreGive(s_send_mux);
            return;
        }
        sent += n;
    }
    xSemaphoreGive(s_send_mux);
}

/* Throttled binary send — for large payloads (voice) that would otherwise
 * burst-overwhelm the esp_hosted SDIO/WiFi link and stall it. Sends the body
 * in CHUNK-sized pieces with a small yield between them, giving the transport
 * time to drain. Holds the mutex throughout (video pauses briefly). */
void tcp_client_send_binary_throttled(const char *hdr, int hlen, const char *body, int blen)
{
    if (s_sock < 0 || !hdr || hlen <= 0 || !body || blen <= 0 || !s_send_mux) return;
    const int CHUNK = 8192;
    const TickType_t YIELD = pdMS_TO_TICKS(10);

    xSemaphoreTake(s_send_mux, portMAX_DELAY);
    int fd = s_sock;
    if (fd < 0) { xSemaphoreGive(s_send_mux); return; }

    /* Header */
    int sent = 0;
    while (sent < hlen) {
        int n = send(fd, hdr + sent, hlen - sent, 0);
        if (n <= 0) { shutdown(fd, SHUT_RDWR); close(s_sock); s_sock = -1; s_connected = false; xSemaphoreGive(s_send_mux); return; }
        sent += n;
    }
    /* Body in throttled chunks */
    sent = 0;
    while (sent < blen) {
        int want = (blen - sent < CHUNK) ? (blen - sent) : CHUNK;
        int chunk_sent = 0;
        while (chunk_sent < want) {
            int n = send(fd, body + sent + chunk_sent, want - chunk_sent, 0);
            if (n <= 0) {
                ESP_LOGW(TAG, "throttled send failed at %d/%d → reconnect", sent, blen);
                shutdown(fd, SHUT_RDWR);
                close(s_sock);
                s_sock = -1;
                s_connected = false;
                xSemaphoreGive(s_send_mux);
                return;
            }
            chunk_sent += n;
        }
        sent += want;
        if (sent < blen) vTaskDelay(YIELD);  /* let esp_hosted drain */
    }
    xSemaphoreGive(s_send_mux);
}

/* Non-blocking send: returns 1 if sent, 0 if buffer full (skip frame) */
int tcp_client_send_nonblock(const char *data, int len)
{
    if (s_sock < 0 || !data || len <= 0) return 0;
    /* Check if socket is writable with 0-timeout select */
    fd_set wfds;
    FD_ZERO(&wfds);
    FD_SET(s_sock, &wfds);
    struct timeval tv = { .tv_sec = 0, .tv_usec = 0 };
    if (select(s_sock + 1, NULL, &wfds, NULL, &tv) == 1) {
        int sent = send(s_sock, data, len, 0);
        return (sent > 0) ? 1 : 0;
    }
    return 0;  /* buffer full — caller should skip this frame */
}
