#include <string.h>
#include <sys/socket.h>
#include <netdb.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "lwip/netdb.h"
#include "esp_random.h"

#include "tcp_client.h"
#include "nav/nav_grid.h"

static const char *TAG = "tcp_client";

#define RECONNECT_DELAY_MS   2000
#define RECONNECT_MAX_DELAY  60000
#define READ_BUF_SIZE        512

static const char *s_host;
static uint16_t   s_port;
static bool       s_connected = false;
static int        s_sock     = -1;
static TaskHandle_t s_task_handle;

#define LINE_BUF_SIZE 512
static char s_line_buf[LINE_BUF_SIZE];
static int s_line_len = 0;

/* ─── MAP 接收状态机 ─────────────────────────────────────────── */
typedef enum {
    TCP_PARSE_LINE,   /* 默认：逐行解析 */
    TCP_RECV_BINARY,  /* 正在接收地图像素流 */
} tcp_recv_state_t;

static tcp_recv_state_t s_tcp_recv_state = TCP_PARSE_LINE;
static bool             s_map_in_progress = false; /* 独立标记：当前是否在接收地图过程中 */
static int             s_map_w = 0, s_map_h = 0;
static int             s_map_recv = 0;   /* 已接收的像素字节数 */

typedef enum {
    ESP_IDLE,
    ESP_MOVING,
} esp_state_t;

static esp_state_t s_esp_state = ESP_IDLE;
static TaskHandle_t s_nav_timer_handle;

static void tcp_client_task(void *arg);

esp_err_t tcp_client_init(const char *host, uint16_t port)
{
    if (!host || port == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    s_host = host;
    s_port = port;
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

    freeaddrinfo(res);
    ESP_LOGI(TAG, "Connected to %s:%d, sock=%d", host, port, sock);
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

/* ─── Navigation simulation task ──────────────────────────── */

static void nav_sim_task(void *arg)
{
    (void)arg;
    uint32_t delay_ms = 3000 + (esp_random() % 5000);
    vTaskDelay(pdMS_TO_TICKS(delay_ms));

    if (s_esp_state == ESP_MOVING) {
        s_esp_state = ESP_IDLE;
        send(s_sock, "EXEC:A\r\n", 8, 0);
        ESP_LOGI(TAG, "Simulated arrival (waited %ums)", delay_ms);
    }
    s_nav_timer_handle = NULL;
    vTaskDelete(NULL);
}

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
    send(s_sock, "ACK:MAP\r\n", 9, 0);
    ESP_LOGI(TAG, "MAP received (%dx%d), ACK sent", s_map_w, s_map_h);
}

/* ─── Command dispatch ─────────────────────────────────────── */

static void dispatch_cmd(const char *line)
{
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

    if (memcmp(line, "CMD:", 4) != 0) {
        send(s_sock, "ERR:EXPECTED_CMD\r\n", 19, 0);
        return;
    }

    const char *cmd = line + 4;

    if (strcmp(cmd, "PING") == 0) {
        send(s_sock, "OK:PING\r\n", 9, 0);
        return;
    }

    if (strncmp(cmd, "NAV:", 4) == 0) {
        /* CMD:NAV:x=<float>,y=<float>[,speed=<float>] */
        float x = kv_get_float(cmd, "x", -999);
        float y = kv_get_float(cmd, "y", -999);
        if (x == -999 || y == -999) {
            send(s_sock, "ERR:INVALID_NAV\r\n", 18, 0);
            return;
        }

        /* 地图通行性检查（起点 = 当前 robot 位置，需要读取传感器，这里暂时用 (0,0) 或后续补充） */
        if (!grid_is_passable(x, y)) {
            send(s_sock, "NAV:REJECT\r\n", 13, 0);
            ESP_LOGW(TAG, "NAV rejected: (%.2f, %.2f) blocked", x, y);
            return;
        }

        /* cancel any pending simulation */
        if (s_nav_timer_handle != NULL) {
            vTaskDelete(s_nav_timer_handle);
            s_nav_timer_handle = NULL;
        }

        s_esp_state = ESP_MOVING;
        send(s_sock, "EXEC:S\r\n", 8, 0);
        xTaskCreate(&nav_sim_task, "nav_sim", 2048, NULL,
                    tskIDLE_PRIORITY + 2, &s_nav_timer_handle);
        ESP_LOGI(TAG, "Nav started to (%.2f, %.2f)", x, y);
        return;
    }

    if (strcmp(cmd, "STOP") == 0) {
        if (s_nav_timer_handle != NULL) {
            vTaskDelete(s_nav_timer_handle);
            s_nav_timer_handle = NULL;
        }
        s_esp_state = ESP_IDLE;
        send(s_sock, "EXEC:S\r\n", 8, 0);
        ESP_LOGI(TAG, "Nav stopped");
        return;
    }

    send(s_sock, "ERR:UNKNOWN_CMD\r\n", 17, 0);
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

        /* ── LINE 模式：按 \n 切分行 ── */
        while (s_tcp_recv_state == TCP_PARSE_LINE) {
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
                        ESP_LOGI(TAG, "recv: %s", s_line_buf);
                        dispatch_cmd(s_line_buf);
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
