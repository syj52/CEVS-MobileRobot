本工程基于用户提供的官方 Bluetooth_Control 工程，只做最小改动：

1. 保留官方蓝牙协议解析、官方 Deal_Motor_Data() 和官方 L/R 转弯模式。
2. 增加 USART1 接收入口：ESP32 通过 PA10/PA9 与 STM32 通信。
3. ESP32 不再发送 F/L/R/S 单字节，而是发送官方蓝牙 APP 风格帧，例如 $1,0,0,0,0,0,0,0,0,0#。
4. 在 Get_Data() 中加入 EXEC 回传观察点：完整帧进入官方运动解析后，STM32 通过 USART1 返回 EXEC:F / EXEC:S / EXEC:L / EXEC:R。

接线：
ESP32 GPIO5/TX -> STM32 PA10/USART1_RX
ESP32 GPIO6/RX <- STM32 PA9/USART1_TX
ESP32 GND      <-> STM32 GND

波特率：USART1 与 ESP32 均为 4800。UART5 蓝牙仍保留官方 9600 配置。

测试建议：
1. ESP32 先只发送停止帧 $0,0,0,0,0,0,0,0,0,0#，观察 RX: EXEC:S。
2. 再测试前进/停止帧。
3. 再测试左转/停止帧。
4. 如果出现 TX: 左转帧 -> RX: EXEC:L，TX: 停止帧 -> RX: EXEC:S，但小车仍不停，说明串口和官方解析已执行，问题集中在官方转弯状态退出/电机底层状态清除。
