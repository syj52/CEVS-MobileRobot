#ifndef __BSP_UART5_H__
#define __BSP_UART5_H__

#ifdef __cplusplus
extern "C"
{
#endif

/* Includes ------------------------------------------------------------------*/
#include "bsp.h"

    void UART5_Init(void);
    void USRT5_DataByte(uint8_t data_byte);
    void USRT5_DataString(uint8_t *data_str, uint16_t datasize);

#ifdef __cplusplus
}
#endif

#endif /* __USART_H__ */

/************************ (C) COPYRIGHT STMicroelectronics *****END OF FILE****/
