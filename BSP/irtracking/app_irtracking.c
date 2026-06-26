/*
 * app_irtracking.c
 *
 *  Created on: Oct 25, 2023
 *      Author: YB-101
 */

#include "app_irtracking.h"

/*
 * 简单的4路巡线
 *
 * Simple 4-way line patrol
 * */
void car_irtrack(void)
{

	if((IN_X1 == 0 && IN_X3 == 0) && IN_X2 == 1 && IN_X4 == 1) //直走 go straight
	{
		Motion_Set_Speed(300,300,300,300);
	}


	if(IN_X1 == 0 && IN_X3 == 1 && IN_X4 == 1 && IN_X2 == 1)//小幅度调整 small adjustment
	{
			Motion_Set_Speed(0,0,500,500);
	}
	else	if(IN_X1 == 1 && IN_X3 == 0 && IN_X4 == 1 && IN_X2 == 1)
	{
			Motion_Set_Speed(500,500,0,0);
	}


	if(IN_X2 == 0 && IN_X3 == 1 ) //大幅度左右转 Turn left and right sharply
	{
			Motion_Set_Speed(-500,-500,500,500);
	}
	else if(IN_X4 == 0 && IN_X1 == 1 )
	{
			Motion_Set_Speed(500,500,-500,-500);
	}

	//其它情况保持不变 Other things remain unchanged
}

//获取4路传感器的值
//Obtain the values of four sensors
int GetLineWalking_Data(void)
{
	int returnValue = 0;
	returnValue = (IN_X2 == 1?0:1000);
	returnValue += (IN_X1 == 1?0:100);
	returnValue += (IN_X3 == 1?0:10);
	returnValue += (IN_X4 == 1?0:1);

	return returnValue;
}
