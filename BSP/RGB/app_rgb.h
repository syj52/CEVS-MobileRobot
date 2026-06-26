#ifndef __APP_RGB_H_
#define __APP_RGB_H_

#include "bsp.h"


typedef enum color_effect
{
	CUT_RGB = 1,
	FOLLOE_RGB,
	A_WATER,
	B_WATER,
	A_ONE_LIHGRT,
	B_ONE_LIHGRT,
	RGB_EFFCT_MAX
}Color_effect_t;

void Colorful_RGB(uint16_t red,uint16_t green,uint16_t blue);
void RGB_color_ALL(uint32_t times);
void RGB_color_follow(uint32_t times);
void RGB_color_water(uint8_t direction,uint32_t times);
void user_control(Color_effect_t effect);

#endif


