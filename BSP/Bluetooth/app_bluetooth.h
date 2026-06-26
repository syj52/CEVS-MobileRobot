#ifndef __APP_BLUETOOTH_H_
#define __APP_BLUETOOTH_H_

#include "bsp.h"


void USE_Bluetooth_Control(void);
void OLED_SHOW_BAT(void);
void OLED_SHOW_Car_Speed(void);
void OLED_SHOW_DIS(void);
void OLED_SHOW_IRDIS(void);

void Send_Msg(void);//发送数据函数 Send Data Function

extern uint8_t g_modeSelect; //引出模式标志 Export Mode Flag

#endif


