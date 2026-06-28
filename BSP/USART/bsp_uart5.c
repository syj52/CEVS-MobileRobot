#include "bsp_uart5.h"

void UART5_Init(void)
{

	LL_USART_EnableIT_RXNE(UART5); // Start receiving interrupt 启动接收中断
}

/*
 * UART5_IRQHandler 目前禁用 (在 CubeMX 生成的 stm32f1xx_it.c 中有空壳占位).
 * UART5 重新启用时取消注释此处, 并注释掉 stm32f1xx_it.c 中的弱定义.
 *
void UART5_IRQHandler(void)
{
	uint8_t rx5_temp;
	if (LL_USART_IsEnabledIT_RXNE(UART5))
	{
		rx5_temp = LL_USART_ReceiveData8(UART5);
		Deal_Bluetooth(rx5_temp);
	}
}
*/

// Send a Byte 发送一个字节
void USRT5_DataByte(uint8_t data_byte)
{
	while (!LL_USART_IsActiveFlag_TXE(UART5))
	{
	};
	LL_USART_TransmitData8(UART5, data_byte);
}

// Set to send a string 设置发送一个字符串
void USRT5_DataString(uint8_t *data_str, uint16_t datasize)
{
	for (uint8_t len = 0; len < datasize; len++)
	{
		USRT5_DataByte(*(data_str + len));
	}
}
