#ifndef __BSP_USART1_H_
#define __BSP_USART1_H_

#include <stdio.h>
#include "main.h"
#include "bsp.h"

void USART1_Receive_IT_Start(void);
void USART1_Send(uint8_t *data_str, uint16_t datasize);

extern volatile uint32_t g_usart1_rx_count;
extern volatile uint32_t g_usart1_err_count;

#endif
