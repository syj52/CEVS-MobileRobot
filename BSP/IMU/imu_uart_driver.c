/**
 * @file    imu_uart_driver.c
 * @brief   YB-IMU 六轴型 UART 驱动实现 (LL 库, UART4)
 *
 * 协议帧: [7E] [23] [LEN] [FUNC] [DATA...] [CHECKSUM]
 * 单片机: STM32F103ZETx, 使用 LL_USART API 操作 UART4
 * 参考源: YbImuSerialLib.py (Python 官方驱动) + STM32 SPL 版本
 */

#include "imu_uart_driver.h"
#include "main.h"
#include "delay.h"
#include <stdio.h>
#include <string.h>
#include <math.h>

/* ========== 环形接收缓冲区 / RX ring buffer ========== */
static volatile uint8_t  s_rx_buffer[IMU_UART_RX_BUF_SIZE];
static volatile uint16_t s_rx_write = 0;
static volatile uint16_t s_rx_read  = 0;

/* 诊断计数器 / Diagnostic counters */
volatile uint32_t g_imu_rx_bytes  = 0;  /* UART4 收到的总字节数 */
volatile uint32_t g_imu_rx_frames = 0;  /* 成功解析的完整帧数 */

static inline uint16_t _rb_next(uint16_t idx)
{
    return (uint16_t)((idx + 1u) % IMU_UART_RX_BUF_SIZE);
}

static inline int _rb_is_empty(void)
{
    return s_rx_write == s_rx_read;
}

static inline void _rb_push(uint8_t b)
{
    uint16_t next = _rb_next(s_rx_write);
    if (next == s_rx_read) {
        /* 缓冲区满: 丢弃最旧字节 / buffer full, drop oldest */
        s_rx_read = _rb_next(s_rx_read);
    }
    s_rx_buffer[s_rx_write] = b;
    s_rx_write = next;
}

static inline int _rb_pop(uint8_t *out)
{
    if (_rb_is_empty()) return -1;
    *out = s_rx_buffer[s_rx_read];
    s_rx_read = _rb_next(s_rx_read);
    return 0;
}

/* ========== 传感器数据缓存 / Sensor data cache ========== */
static volatile float s_ax = 0.0f, s_ay = 0.0f, s_az = 0.0f;
static volatile float s_gx = 0.0f, s_gy = 0.0f, s_gz = 0.0f;
static volatile float s_roll = 0.0f, s_pitch = 0.0f, s_yaw = 0.0f;
static volatile float s_q0 = 0.0f, s_q1 = 0.0f, s_q2 = 0.0f, s_q3 = 0.0f;
static volatile int   s_version_h = -1, s_version_m = 0, s_version_l = 0;
static volatile uint8_t s_rx_func = 0;
static volatile int16_t s_rx_state_val = -1;

/* ========== 小端序字节转换 / Little-endian byte conversion ========== */
static int16_t _bytes_to_int16(const uint8_t *b)
{
    return (int16_t)((b[1] << 8) | b[0]);
}

static float _bytes_to_float(const uint8_t *b)
{
    float v;
    memcpy(&v, b, sizeof(float));
    return v;
}

/* ========== 帧数据解析 / Frame data parser ========== */
static void _parse_frame(uint8_t func, const uint8_t *data)
{
    switch (func) {
    case IMU_FUNC_REPORT_IMU_RAW: {
        /* 六轴型: 12 字节 = accel×3(int16) + gyro×3(int16), 无磁力计 */
        float accel_r = 16.0f / 32767.0f;
        s_ax = _bytes_to_int16(&data[0])  * accel_r;
        s_ay = _bytes_to_int16(&data[2])  * accel_r;
        s_az = _bytes_to_int16(&data[4])  * accel_r;

        float gyro_r = (2000.0f / 32767.0f) * (3.14159265358979323846f / 180.0f);
        s_gx = _bytes_to_int16(&data[6])  * gyro_r;
        s_gy = _bytes_to_int16(&data[8])  * gyro_r;
        s_gz = _bytes_to_int16(&data[10]) * gyro_r;
        break;
    }
    case IMU_FUNC_REPORT_IMU_EULER:
        s_roll  = _bytes_to_float(&data[0]);
        s_pitch = _bytes_to_float(&data[4]);
        s_yaw   = _bytes_to_float(&data[8]);
        break;
    case IMU_FUNC_REPORT_IMU_QUAT:
        s_q0 = _bytes_to_float(&data[0]);
        s_q1 = _bytes_to_float(&data[4]);
        s_q2 = _bytes_to_float(&data[8]);
        s_q3 = _bytes_to_float(&data[12]);
        break;
    case IMU_FUNC_VERSION:
        s_version_h = data[0];
        s_version_m = data[1];
        s_version_l = data[2];
        break;
    case IMU_FUNC_RETURN_STATE:
        s_rx_func    = data[0];
        s_rx_state_val = (int16_t)data[1];
        break;
    default:
        break;
    }
}

/* ========== ISR 入口: 环形缓冲区写入 / ISR entry: push to ring buffer ========== */
/* 收到连续非帧头字节时打印诊断 / print raw bytes when no valid header found */
volatile uint8_t  g_imu_diag_buf[32];
volatile uint16_t g_imu_diag_cnt = 0;
volatile uint8_t  g_imu_diag_printed = 0;

void IMU_UART_FeedByte(uint8_t byte_val)
{
    g_imu_rx_bytes++;
    if (g_imu_diag_cnt < sizeof(g_imu_diag_buf)) {
        g_imu_diag_buf[g_imu_diag_cnt++] = byte_val;
    }
    _rb_push(byte_val);
}

/* ========== 主循环调用: 解析环形缓冲区中的完整帧 / Frame parser ========== */
void IMU_UART_Process(void)
{
    enum {
        ST_EXPECT_HEAD1 = 0,
        ST_EXPECT_HEAD2,
        ST_EXPECT_LENGTH,
        ST_EXPECT_FUNCTION,
        ST_COLLECT_DATA
    };

    static uint8_t  state = ST_EXPECT_HEAD1;
    static uint8_t  frame_len = 0;
    static uint8_t  frame_func = 0;
    static uint8_t  frame_buf[64];
    static uint16_t frame_idx = 0;

    uint8_t b;

    while (_rb_pop(&b) == 0) {
        switch (state) {
        case ST_EXPECT_HEAD1:
            if (b == FRAME_HEAD1) state = ST_EXPECT_HEAD2;
            break;

        case ST_EXPECT_HEAD2:
            state = (b == FRAME_HEAD2) ? ST_EXPECT_LENGTH : ST_EXPECT_HEAD1;
            break;

        case ST_EXPECT_LENGTH:
            frame_len = b;
            state = ST_EXPECT_FUNCTION;
            break;

        case ST_EXPECT_FUNCTION:
            frame_func = b;
            frame_idx = 0;
            state = ST_COLLECT_DATA;
            break;

        case ST_COLLECT_DATA: {
            uint16_t data_len = (frame_len >= 4) ? (uint16_t)(frame_len - 4) : 0;
            if (data_len == 0 || data_len > sizeof(frame_buf)) {
                state = ST_EXPECT_HEAD1;
                break;
            }

            frame_buf[frame_idx++] = b;
            if (frame_idx >= data_len) {
                /* 校验 / validate checksum */
                uint8_t calc = (uint8_t)(FRAME_HEAD1 + FRAME_HEAD2 + frame_len + frame_func);
                for (uint16_t i = 0; i < data_len - 1; ++i) {
                    calc = (uint8_t)(calc + frame_buf[i]);
                }
                uint8_t rx_cs = frame_buf[data_len - 1];
                if (calc == rx_cs) {
                    g_imu_rx_frames++;
                    _parse_frame(frame_func, frame_buf);
                }
                state = ST_EXPECT_HEAD1;
            }
            break;
        }

        default:
            state = ST_EXPECT_HEAD1;
            break;
        }
    }
}

/* ========== 清除缓存 / Clear cache ========== */
void IMU_UART_ClearAutoReportData(void)
{
    s_ax = s_ay = s_az = 0.0f;
    s_gx = s_gy = s_gz = 0.0f;
    s_roll = s_pitch = s_yaw = 0.0f;
    s_q0 = s_q1 = s_q2 = s_q3 = 0.0f;
}

/* ========== 读取传感器数据 / Read sensor data ========== */
int IMU_UART_GetAccelerometer(float out[3])
{
    if (!out) return -1;
    out[0] = s_ax; out[1] = s_ay; out[2] = s_az;
    return 0;
}

int IMU_UART_GetGyroscope(float out[3])
{
    if (!out) return -1;
    out[0] = s_gx; out[1] = s_gy; out[2] = s_gz;
    return 0;
}

int IMU_UART_GetQuaternion(float out[4])
{
    if (!out) return -1;
    out[0] = s_q0; out[1] = s_q1; out[2] = s_q2; out[3] = s_q3;
    return 0;
}

int IMU_UART_GetEuler(float out[3])
{
    if (!out) return -1;
    const float RAD2DEG = 57.2957795f;
    out[0] = s_roll  * RAD2DEG;
    out[1] = s_pitch * RAD2DEG;
    out[2] = s_yaw   * RAD2DEG;
    return 0;
}

int IMU_UART_GetAll(imu_measurement_t *out)
{
    if (!out) return -1;
    IMU_UART_GetAccelerometer(out->accel);
    IMU_UART_GetGyroscope(out->gyro);
    IMU_UART_GetQuaternion(out->quat);
    IMU_UART_GetEuler(out->euler);
    return 0;
}

/* ========== 底层发送 / Low-level send via UART4 ========== */
static void _uart4_send_byte(uint8_t data)
{
    while (!LL_USART_IsActiveFlag_TXE(UART4)) { }
    LL_USART_TransmitData8(UART4, data);
}

static void _uart4_send_array(const uint8_t *data, uint8_t len)
{
    for (uint8_t i = 0; i < len; ++i) {
        _uart4_send_byte(data[i]);
    }
}

/* ========== 命令发送 / Command sending ========== */
int IMU_UART_SendCommand(uint8_t function, const uint8_t *params, uint8_t param_len)
{
    if (param_len > 3 || (param_len > 0 && params == NULL)) {
        return -1;
    }

    /* 构造帧: HEAD1 HEAD2 LEN FUNC [PARAM...] CHECKSUM
     * LEN 占用 1 字节, 所以帧内容最大 255
     * 实际缓存: 2(head) + 1(len) + 1(func) + 3(param max) + 1(cs) = 8 */
    uint8_t frame[8] = { FRAME_HEAD1, FRAME_HEAD2, 0, function, 0, 0, 0, 0 };

    for (uint8_t i = 0; i < param_len; ++i) {
        frame[4 + i] = params[i];
    }

    uint8_t frame_len = (uint8_t)(4 + param_len + 1); /* head(2)+len(1)+func(1)=4, +params, +cs */
    frame[2] = frame_len;

    uint8_t cs = 0;
    for (uint8_t i = 0; i < frame_len - 1; ++i) {
        cs = (uint8_t)(cs + frame[i]);
    }
    frame[frame_len - 1] = cs;

    _uart4_send_array(frame, frame_len);
    return 0;
}

/* ========== 版本查询 / Get version ========== */
void IMU_UART_GetVersion(void)
{
    s_version_h = -1;
    s_version_m = 0;
    s_version_l = 0;

    /* 发送请求版本命令 */
    uint8_t payload[2] = { IMU_FUNC_VERSION, 0x00 };
    IMU_UART_SendCommand(IMU_FUNC_REQUEST_DATA, payload, 2);

    /* 等待返回, 最多约 100ms */
    for (int i = 0; i < 10; ++i) {
        IMU_UART_Process();
        if (s_version_h >= 0) {
            printf("[IMU] Version: V%d.%d.%d\r\n", s_version_h, s_version_m, s_version_l);
            return;
        }
        Delay_MS(10);
    }
    printf("[IMU] Version: timeout\r\n");
}

/* ========== 校准 / Calibration ========== */

static int _calib_wait(uint8_t func, const char *label, uint32_t timeout_ms)
{
    s_rx_func = 0;
    s_rx_state_val = -1;

    uint32_t elapsed = 0;
    while (1) {
        IMU_UART_Process();

        if (s_rx_func == func) {
            return s_rx_state_val;
        }

        if (timeout_ms != 0 && elapsed >= timeout_ms) {
            return -1;
        }

        Delay_MS(1);
        if (timeout_ms != 0) {
            ++elapsed;
        }
    }
}

int IMU_UART_CalibrationImu(void)
{
    uint8_t payload[2] = { 0x01, 0x5F };
    int rc = IMU_UART_SendCommand(IMU_FUNC_CALIB_IMU, payload, 2);
    if (rc != 0) return rc;

    int result = _calib_wait(IMU_FUNC_CALIB_IMU, "imu", 7000);
    if (result == -1) {
        printf("[IMU] Calibration IMU: timeout\r\n");
    } else if (result == 1) {
        printf("[IMU] Calibration IMU: success\r\n");
    } else {
        printf("[IMU] Calibration IMU: failed (code=%d)\r\n", result);
    }
    return result;
}

int IMU_UART_ResetUserData(void)
{
    uint8_t payload[2] = { 0x01, 0x5F };
    return IMU_UART_SendCommand(IMU_FUNC_RESET_FLASH, payload, 2);
}

int IMU_UART_WaitCalibration(uint8_t function, uint32_t timeout_ms)
{
    return _calib_wait(function, "calib", timeout_ms);
}
