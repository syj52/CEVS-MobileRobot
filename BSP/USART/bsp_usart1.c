#include "bsp_usart1.h"

#define USART_DEBUG huart1

static uint8_t usart1_rx_byte = 0;

/* USART1 receive diagnostics. These counters are only for debugging. */
volatile uint32_t g_usart1_rx_count = 0;
volatile uint32_t g_usart1_err_count = 0;

#ifdef __GNUC__
#define PUTCHAR_PROTOTYPE int __io_putchar(int ch)
#else
#define PUTCHAR_PROTOTYPE int fputc(int ch, FILE *f)
#endif

PUTCHAR_PROTOTYPE
{
  HAL_UART_Transmit(&USART_DEBUG, (uint8_t *)&ch, 1, 0xFFFF);
  return ch;
}

/* Start USART1 single-byte interrupt reception.
 * ESP32 -> STM32: GPIO5/TX -> PA10/USART1_RX.
 */
void USART1_Receive_IT_Start(void)
{
  HAL_UART_Receive_IT(&huart1, &usart1_rx_byte, 1);
}

/* Send bytes through USART1. Used to return EXEC information to ESP32. */
void USART1_Send(uint8_t *data_str, uint16_t datasize)
{
  HAL_UART_Transmit(&huart1, data_str, datasize, 0xFFFF);
}

/* USART1 receives bytes from ESP32 and passes them to the original Bluetooth
 * protocol parser. Do not control motors here. The original project will
 * execute commands later in BSP_Loop() -> USE_Bluetooth_Control() -> Get_Data().
 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1)
  {
    g_usart1_rx_count++;
    Deal_Bluetooth(usart1_rx_byte);
    HAL_UART_Receive_IT(&huart1, &usart1_rx_byte, 1);
  }
}

/* If USART1 has an error, restart reception so the link does not silently die. */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1)
  {
    g_usart1_err_count++;
    HAL_UART_Receive_IT(&huart1, &usart1_rx_byte, 1);
  }
}
