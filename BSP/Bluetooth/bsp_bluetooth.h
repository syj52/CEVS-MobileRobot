#ifndef __BSP_BLUETOOTH_H_
#define __BSP_BLUETOOTH_H_

#include "bsp.h"

void Get_Data(void);


void Deal_Bluetooth(uint8_t msg);

void Deal_Mode(void);
void Deal_Motor_Data(void);
void Deal_RGB_Data(void);
void Deal_Servo_RGB_BEEP_Data(void);
void Deal_PWM_Servo(void);

void Copy_Bluetooth_Data(void);
int StringFind(const char *pSrc, const char *pDst, int v_iStartPos);

extern int CarSpeedControl;//小车速度 car speed

#endif


