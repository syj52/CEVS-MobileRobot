#include "bsp.h"

//app只控制S1路的舵机
//The app only controls the servo of S1 channel

//0: If you don't go in and control the steering gear, it will be interrupted. 1: If you go in and control the steering gear, it can only control the rotation angle, but it won't lock up.
//You can change the angle by turning it manually.
//0:不进去控制舵机中断了 1:进去舵机中断  只能是控制转动的角度，但不锁死，可以用手转动改变角度。
uint8_t g_servo_falg = 0;

//Hardware Initialization
//Parameter:None
void BSP_Init(void)
{
    Delay_Init();
    IR_SWitch(ENABLE);

    Bsp_Tim_Init();
    PID_Param_Init();

    OLED_Init();
    OLED_Draw_Line("Bluetooth Control.", 1, false, true);

    // UART5_Init();   // 先注释掉，ESP32 调试阶段不要让 UART5 参与 Deal_Bluetooth

    /* CubeMX 未启用 USART1 NVIC, 必须手动开启 (RX 中断和 DMA TC 中断都需要) */
    NVIC_SetPriority(USART1_IRQn, NVIC_EncodePriority(NVIC_GetPriorityGrouping(), 0, 0));
    NVIC_EnableIRQ(USART1_IRQn);
    USART1_Receive_IT_Start();

    /*
     * IMU: PC10 已在 main() 最开头拉高, UART4 由 MX_UART4_Init 配置完成。
     * YB-IMU 上电自动上报, 稍等一下让其稳定即可。
     */
    Delay_MS(200);

    Tim_Base_Init();

    PwmServo_Set_Angle_All(90,90,90,90);
}

extern int send_time;//引入中断标志 Introducing interrupt flags

//Loop Run Function
//Parameter:None
void BSP_Loop(void)
{
    /*
     * 第一优先级：先处理 ESP32 / USART1 发来的完整控制帧。
     * 当前调试阶段先保证小车能响应指令。
     */
	// USE_Bluetooth_Control();

    /*
     * IMU 数据处理: 解析 UART4 环形缓冲区中的 YB-IMU 帧，更新传感器缓存。
     * 非阻塞 —— 只处理当前已收到的完整帧。
     */
    IMU_UART_Process();

#if IMU_DEBUG
    /* 每 2 秒打印一次 IMU 连接诊断 (调试用 / debug only) */
    {
        static uint32_t last_diag = 0;
        uint32_t now = HAL_GetTick();
        if (g_imu_rx_frames == 0 && (now - last_diag > 2000)) {
            last_diag = now;
            printf("[IMU] rx_bytes=%lu rx_frames=%lu | raw: ",
                   g_imu_rx_bytes, g_imu_rx_frames);
            for (uint16_t i = 0; i < g_imu_diag_cnt && i < 16; i++) {
                printf("%02X ", g_imu_diag_buf[i]);
            }
            printf("\r\n");
            g_imu_diag_cnt = 0;
        }
    }
#endif

    /*
     * 每 50ms 向 ESP32 上报 IMU 数据: 欧拉角(°)+角速度(rad/s)+加速度(g)
     * 欧拉角用于姿态参考, 角速度是运动控制核心(Yaw不漂移), 加速度用于倾斜补偿.
     * ESP32 端通过 "$IMU" 前缀区分 IMU 帧 vs EXEC 回执.
     * todo: 改成DMA非阻塞发送
     */
    {
        static uint32_t last_imu_rpt = 0;
        uint32_t now = HAL_GetTick();
        if (now - last_imu_rpt > 1000) {
            last_imu_rpt = now;

            imu_measurement_t imu;
            IMU_UART_GetAll(&imu);

            static char imu_buf[200];  /* static: DMA 异步发送期间数据须保持有效 */
            int len = sprintf(imu_buf,
                "$IMU,EULER,%.2f,%.2f,%.2f,GYRO,%.3f,%.3f,%.3f,ACCEL,%.3f,%.3f,%.3f#\r\n",
                imu.euler[0], imu.euler[1], imu.euler[2],
                imu.gyro[0],  imu.gyro[1],  imu.gyro[2],
                imu.accel[0], imu.accel[1], imu.accel[2]);
            USART1_Send((uint8_t *)imu_buf, (uint16_t)len);
        }
    }

    /*
     * 当前调试阶段只保留轻量 OLED 显示。
     * 不调用 Send_Msg()，避免里面的 Get_distance() 阻塞主循环。

    OLED_SHOW_BAT();
    OLED_SHOW_Car_Speed();
    */
    /*
     * 暂时禁用：
     * Send_Msg() 会调用 Get_distance()，如果超声波 ECHO 没返回，
     * 主循环会被 while(...) 卡住，导致指令无法执行。
     */
    /*
    if(g_modeSelect == 0 || g_modeSelect == 1)
    {
        if(send_time == 0)
        {
            Send_Msg();
        }
    }
    */
}
