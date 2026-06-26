/*
 * app_Iravoid.c
 *
 *  Created on: Oct 27, 2023
 *      Author: YB-101
 */

#include "app_iravoid.h"

/*
 * 超声波结合红外做避障
 * uint16_t distance 避障的距离 单位：cm
 *
 * Ultrasound combined with infrared for obstacle avoidance
 * uint16_t distance obstacle avoidance distance unit: cm
 * */

void Ir_Ultrasonic_avoid(uint16_t distance)
{
	uint16_t left_data = 0;
	uint16_t right_data = 0;
	uint16_t dis;
	dis=Get_distance();
	Get_Iravoid_Data(&left_data,&right_data);//串口打印采集的数据 Serial port printing of collected data
	if((distance >2.0 && dis < distance )||(left_data <500||right_data<500))
		{
			//小车停止 Car stops
			wheel_State(MOTION_STOP,0);
			HAL_Delay(500);

			//小车后退 Car backs up
			wheel_State(MOTION_BACK,250);
			HAL_Delay(1000);

			Get_Iravoid_Data(&left_data,&right_data);

			if(left_data>=right_data)
			{
				//小车左转 Car left
				wheel_State(MOTION_SPIN_LEFT,500);
				HAL_Delay(500);
			}
			else
			{
				//小车右转 Car right
				wheel_State(MOTION_SPIN_RIGHT,500);
				HAL_Delay(500);
			}


		}
		else
		{
			//小车前进 The car moves forward
			wheel_State(MOTION_RUN,250);
		}


}


int Get_Iraviod_App(void)
{
	uint16_t IRleft_data5 = 0;
	uint16_t IRright_data5 = 0;
	Get_Iravoid_Data(&IRleft_data5,&IRright_data5);

	uint8_t hh = 0;
	if(IRleft_data5 <600)
		hh += 10;
	if(IRright_data5 < 600)
		hh += 1;

	return hh;

}
