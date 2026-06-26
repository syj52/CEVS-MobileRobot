#include "bsp_buzzer.h"


//函数功能:鸣笛的特效
//Function function: special effects for honking horns
void whistle(void)
{
	  BEEP_ON;
	  HAL_Delay(200);
	  BEEP_OFF;
	  HAL_Delay(200);

	  BEEP_ON;
	  HAL_Delay(400);
	  BEEP_OFF;
}


//函数功能:提示声
//Function function: prompt sound
void BeepOnOffMode(void)
{
	BEEP_ON;
	HAL_Delay(500);
	BEEP_OFF;
}

//函数功能:模式提示声
//Function function: Mode prompt sound
void ModeBEEP(int mode)
{
	int i;
	for (i = 0; i < mode + 1; i++)
	{
		BEEP_ON;
		HAL_Delay(100);
		BEEP_OFF;
		HAL_Delay(100);
	}

	BEEP_OFF;
}
