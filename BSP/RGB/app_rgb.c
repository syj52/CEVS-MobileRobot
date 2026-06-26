#include "app_rgb.h"


extern uint8_t newLineReceived;

//函数功能:点亮RGB颜色 两灯同时点亮
//Function function: Illuminate RGB color and simultaneously illuminate two lights
void Colorful_RGB(uint16_t red,uint16_t green,uint16_t blue)
{
	if(red >0)
	{
		red = set;
	}
	if(green >0)
	{
		green = set;
	}
	if(blue >0)
	{
		blue = set;
	}
	RRGB_SET(red, green, blue);
	LRGB_SET(red, green, blue);

}


//两个RGB灯同时切换7种颜色特效
//Two RGB lights switch to 7 different color effects simultaneously
void RGB_color_ALL(uint32_t times)
{
	for(RGB_Color i = red;i<Max_color;i++)
	{
		Set_RGB(RGB_Max,i);
		HAL_Delay(times);
	}

}

//RGB灯跟随效果
//RGB light following effect
void RGB_color_follow(uint32_t times)
{
	for(RGB_Color i = red;i<=Max_color;i++)
	{
		Set_RGB(RGB_R,(RGB_Color)(i%Max_color));
		Set_RGB(RGB_L,(RGB_Color)((i+1)%Max_color));
		HAL_Delay(times);
	}

}

//RGB灯流水效果
//direction；方向 0从右到左 1从左到右
//times：时间
//RGB light flowing effect
//Direction; Direction 0 from right to left 1 from left to right
//Times: time
void RGB_color_water(uint8_t direction,uint32_t times)
{
	if(direction == 0)
	{
		for(RGB_Color i=red;i<Max_color;i++)
		{
			Set_RGB(RGB_L,(RGB_Color)(i%Max_color));
			if(newLineReceived == 1) break;
			HAL_Delay(times);
			Set_RGB(RGB_R,(RGB_Color)((i)%Max_color));
			HAL_Delay(times);
		}
	}
	else
	{
		for(RGB_Color i=red;i<Max_color;i++)
		{
			Set_RGB(RGB_R,(RGB_Color)(i%Max_color));
			if(newLineReceived == 1) break;
			HAL_Delay(times);
			Set_RGB(RGB_L,(RGB_Color)((i)%Max_color));
			HAL_Delay(times);
		}
	}

}

//单灯轮播效果
//Single light rotation effect
void RGB_one_light(uint8_t direction,uint32_t times)
{
	if(direction == 0)
	{
			for(RGB_Color i=red;i<Max_color;i++)
			{
				Set_RGB(RGB_L,(RGB_Color)(i%Max_color));
				RGB_OFF_R;
				HAL_Delay(times);

				RGB_OFF_L;
				Set_RGB(RGB_R,(RGB_Color)((i)%Max_color));
				HAL_Delay(times);
			}
	}
	else
	{
		for(RGB_Color i=red;i<Max_color;i++)
		{
			RGB_OFF_L;
			Set_RGB(RGB_R,(RGB_Color)((i)%Max_color));
			HAL_Delay(times);

			Set_RGB(RGB_L,(RGB_Color)(i%Max_color));
			RGB_OFF_R;
			HAL_Delay(times);
		}
	}

}

void user_control(Color_effect_t effect)
{
	switch((uint8_t)effect)
	{
		case CUT_RGB:			RGB_color_ALL(400); RGB_OFF_ALL;break;
		case FOLLOE_RGB:		RGB_color_follow(350);RGB_OFF_ALL;break;
		case A_WATER:			RGB_color_water(0,500);RGB_OFF_ALL;break;
		case B_WATER:			RGB_color_water(1,500);RGB_OFF_ALL;break;
		case A_ONE_LIHGRT:		RGB_one_light(0,400);RGB_OFF_ALL;break;
		case B_ONE_LIHGRT:		RGB_one_light(1,400);RGB_OFF_ALL;break;
	}
}
