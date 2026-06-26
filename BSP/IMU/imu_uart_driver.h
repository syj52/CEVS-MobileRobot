/**
 * @file    imu_uart_driver.h
 * @brief   YB-IMU 六轴型 UART 驱动 (LL 库版本)
 *
 * 协议: 帧头 0x7E 0x23, 校验和(低8位), 115200bps
 * 硬件: ICM-42670-P (3轴加速度+3轴陀螺仪), 无磁力计/气压计
 * 适配: UART4 (PC10/TX, PC11/RX)
 */

#ifndef __IMU_UART_DRIVER_H_
#define __IMU_UART_DRIVER_H_

#include <stdint.h>

/* ---------- 配置项 / Config ---------- */
#ifndef IMU_UART_RX_BUF_SIZE
#define IMU_UART_RX_BUF_SIZE 256
#endif

#define FRAME_HEAD1 0x7E
#define FRAME_HEAD2 0x23

/* ---------- 功能码 / Function codes (YbImuSerialLib) ---------- */
#define IMU_FUNC_VERSION        0x01
#define IMU_FUNC_REPORT_IMU_RAW 0x04
#define IMU_FUNC_REPORT_IMU_QUAT 0x16
#define IMU_FUNC_REPORT_IMU_EULER 0x26
#define IMU_FUNC_REPORT_RATE    0x60
#define IMU_FUNC_ALGO_TYPE      0x61
#define IMU_FUNC_CALIB_IMU      0x70
#define IMU_FUNC_REQUEST_DATA   0x80
#define IMU_FUNC_RETURN_STATE   0x81
#define IMU_FUNC_RESET_FLASH    0xA0

/* ---------- 传感器数据结构 / Sensor data struct (六轴型) ---------- */
typedef struct {
    float accel[3];   /* 加速度 g:  ax, ay, az */
    float gyro[3];    /* 角速度 rad/s: gx, gy, gz */
    float quat[4];    /* 四元数: q0(w), q1(x), q2(y), q3(z) */
    float euler[3];   /* 欧拉角 度(°): roll, pitch, yaw */
} imu_measurement_t;

/* ========== 诊断计数器 / Diagnostic counters ========== */
extern volatile uint32_t g_imu_rx_bytes;
extern volatile uint32_t g_imu_rx_frames;
extern volatile uint8_t  g_imu_diag_buf[32];
extern volatile uint16_t g_imu_diag_cnt;
extern volatile uint8_t  g_imu_diag_printed;

/* ========== ISR 入口 / ISR entry ========== */

/**
 * @brief 中断服务例程调用此函数将接收字节写入环形缓冲区
 *        Call from UART4_IRQHandler to push one received byte
 * @param byte_val 接收到的字节
 */
void IMU_UART_FeedByte(uint8_t byte_val);

/* ========== 数据处理 / Data processing ========== */

/**
 * @brief 解析环形缓冲区中的完整帧并更新内部缓存
 *        应在主循环中周期性调用（非阻塞）
 */
void IMU_UART_Process(void);

/**
 * @brief 清除自动上报数据的缓存（初始化为零）
 */
void IMU_UART_ClearAutoReportData(void);

/* ========== 读取传感器数据 / Read sensor data ========== */

int IMU_UART_GetAccelerometer(float out[3]);
int IMU_UART_GetGyroscope(float out[3]);
int IMU_UART_GetQuaternion(float out[4]);
int IMU_UART_GetEuler(float out[3]);

/**
 * @brief 一次性读取全部传感器数据
 * @param out 指向 imu_measurement_t 的指针
 * @return 0 成功
 */
int IMU_UART_GetAll(imu_measurement_t *out);

/* ========== 命令发送 / Command sending ========== */

/**
 * @brief 发送命令帧到 YB-IMU
 * @param function 功能码
 * @param params   参数 (可为 NULL)
 * @param param_len 参数长度 (0~3)
 * @return 0 成功，-1 参数非法
 */
int IMU_UART_SendCommand(uint8_t function, const uint8_t *params, uint8_t param_len);

/* ========== 校准 / Calibration ========== */

int  IMU_UART_CalibrationImu(void);
int  IMU_UART_ResetUserData(void);
int  IMU_UART_WaitCalibration(uint8_t function, uint32_t timeout_ms);

/**
 * @brief 获取 IMU 固件版本
 *        向模块发送版本查询命令，等待返回后通过 USART1 printf 输出
 */
void IMU_UART_GetVersion(void);

#endif /* __IMU_UART_DRIVER_H_ */
