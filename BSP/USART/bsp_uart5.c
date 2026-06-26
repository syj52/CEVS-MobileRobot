#include "bsp_uart5.h"

void UART5_Init(void)
{

	LL_USART_EnableIT_RXNE(UART5); // Start receiving interrupt 启动接收中断
}

/**
 * @brief This function handles UART4 global interrupt.
 */
void UART5_IRQHandler(void)
{
	uint8_t rx5_temp;
	if (LL_USART_IsEnabledIT_RXNE(UART5)) // Determine if there is any interruption information 判断是否有中断信息
	{
		// LL_USART_ClearFlag_RXNE(UART5); //clear interrupt 清除中断
		rx5_temp = LL_USART_ReceiveData8(UART5); // Read information and clear interrupts 读取信息并清除中断
//		 USRT5_DataByte(rx5_temp);//send data 发送数据
		Deal_Bluetooth(rx5_temp);
	}
}

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
