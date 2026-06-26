#ifndef __BSP_VOL_H_
#define __BSP_VOL_H_

#include "bsp.h"

#define BAT_CH ADC_CHANNEL_5

void BAT_ADC_Init(void);

uint16_t Get_BAT(uint32_t ch);
uint16_t Adc_Get_Average(uint32_t ch, uint8_t times);
float Adc_Get_Measure_Volotage(void);
float Adc_Get_Battery_Volotage(void);

#endif
