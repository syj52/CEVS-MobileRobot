#ifndef __BSP_BUZZER_H_
#define __BSP_BUZZER_H_

#include "bsp.h"

void whistle(void);
void ModeBEEP(int mode);
void BeepOnOffMode(void);

#define BEEP_ON  HAL_GPIO_WritePin(BEEP_GPIO_Port, BEEP_Pin, GPIO_PIN_SET)
#define BEEP_OFF HAL_GPIO_WritePin(BEEP_GPIO_Port, BEEP_Pin, GPIO_PIN_RESET)

#endif


