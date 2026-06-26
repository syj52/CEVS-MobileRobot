#ifndef __DELAY_H_
#define __DELAY_H_

#include "main.h"

void Delay_Init(void);
void Delay_US(uint32_t nus);//定时us Timingus
void Delay_MS(uint16_t nms);

#endif

