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

/* ODOM/SNSR data sources — computed in Motion_Handle() every 10ms (TIM6 ISR) */
extern car_data_t   car_data;
extern motor_data_t motor_data;
extern int          g_Encoder_All_Now[MAX_MOTOR];

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
        if (now - last_imu_rpt > 200) {
            last_imu_rpt = now;

            imu_measurement_t imu;
            IMU_UART_GetAll(&imu);

            static char imu_buf[200];  /* static: DMA 异步发送期间数据须保持有效 */
            int len = sprintf(imu_buf,
                "$IMU,EULER,%.2f,%.2f,%.2f,GYRO,%.3f,%.3f,%.3f,ACCEL,%.3f,%.3f,%.3f#\r\n",
                imu.euler[0], imu.euler[1], imu.euler[2],
                imu.gyro[0],  imu.gyro[1],  imu.gyro[2],
                imu.accel[0], imu.accel[1], imu.accel[2]);
            //USART1_Send((uint8_t *)imu_buf, (uint16_t)len);
        }
    }

    /*
     * 每 200ms 向 ESP32 上报 ODOM (里程计) 数据帧。
     * Vx: 前后速度 (mm/s), Vz: 角速度, S1..S4: 四轮实测速度 (mm/s),
     * ENC: 四轮累计编码器脉冲 (开机至今, 32-bit 不溢出).
     * 所有数据在 TIM6 ISR (10ms) 中更新, 读取时始终一致.
     */
    {
        static uint32_t last_odom_rpt = 0;
        uint32_t now = HAL_GetTick();
        if (now - last_odom_rpt > 200) {
            last_odom_rpt = now;

            static char odom_buf[128];  /* static: DMA 异步发送期间数据须保持有效 */
            int len = sprintf(odom_buf,
                "$ODOM,Vx=%d,Vz=%d,S1=%d,S2=%d,S3=%d,S4=%d,ENC=%d,%d,%d,%d#\r\n",
                (int)car_data.Vx,
                (int)car_data.Vz,
                (int)motor_data.speed_mm_s[0],
                (int)motor_data.speed_mm_s[1],
                (int)motor_data.speed_mm_s[2],
                (int)motor_data.speed_mm_s[3],
                g_Encoder_All_Now[0],
                g_Encoder_All_Now[1],
                g_Encoder_All_Now[2],
                g_Encoder_All_Now[3]);
            //USART1_Send((uint8_t *)odom_buf, (uint16_t)len);
        }
    }

    /*
     * 每 500ms 向 ESP32 上报 SNSR (环境传感器) 数据帧。
     * US: 超声波距离 (cm), IRL/IRR: 左右红外避障 ADC 值,
     * X1..X4: 巡线传感器 GPIO 电平 (0=黑线/1=白), BAT: 电池电压 (V).
     * 注意: Get_distance() 内部 while 等待 ECHO 回波, 阻塞约 50-100ms.
     */
    {
        static uint32_t last_snsr_rpt = 0;
        uint32_t now = HAL_GetTick();
        if (now - last_snsr_rpt > 500) {
            last_snsr_rpt = now;

            uint16_t ir_left  = 0;
            uint16_t ir_right = 0;
            Get_Iravoid_Data_NoPrintf(&ir_left, &ir_right);

            static char snsr_buf[96];   /* static: DMA 异步发送期间数据须保持有效 */
            int len = sprintf(snsr_buf,
                "$SNSR,US=%.1f,TO=%u,IRL=%u,IRR=%u,X=%d,%d,%d,%d,BAT=%.2f#\r\n",
                Get_distance(),
                (unsigned int)g_us_timeout_reason,
                (unsigned int)ir_left,
                (unsigned int)ir_right,
                (int)IN_X1,
                (int)IN_X2,
                (int)IN_X3,
                (int)IN_X4,
                (double)Adc_Get_Battery_Volotage());
            USART1_Send((uint8_t *)snsr_buf, (uint16_t)len);
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
