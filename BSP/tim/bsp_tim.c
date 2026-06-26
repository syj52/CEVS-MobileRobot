/*
 * bsp_tim.c
 *
 *  Created on: 2023年10月18日
 *      Author: YB-101
 */

#include "bsp_tim.h"
/*
 * 初始化定时器123458 Initialize TIM1.2.3.4.5.8
 * */
void Bsp_Tim_Init(void)

{
	// 启动tim1的pwm输出 Start the pwm output of tim1
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_3);
	HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_4);

	// 启动tim8的pwm输出 Start the pwm output of tim8
	HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_1);
	HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_2);
	HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_3);
	HAL_TIM_PWM_Start(&htim8, TIM_CHANNEL_4);

	TIM2->CNT = 0x7fff;
	// 启动tim2的编码器模式 Start the encoder mode of tim2
	HAL_TIM_Encoder_Start(&htim2, TIM_CHANNEL_1 | TIM_CHANNEL_2);

	TIM3->CNT = 0x7fff;
	// 启动tim3的编码器模式 Start the encoder mode of tim3
	HAL_TIM_Encoder_Start(&htim3, TIM_CHANNEL_1 | TIM_CHANNEL_2);

	TIM4->CNT = 0x7fff;
	// 启动tim4的编码器模式 Start the encoder mode of tim4
	HAL_TIM_Encoder_Start(&htim4, TIM_CHANNEL_1 | TIM_CHANNEL_2);

	TIM5->CNT = 0x7fff;
	// 启动tim5的编码器模式 Start the encoder mode of tim5
	HAL_TIM_Encoder_Start(&htim5, TIM_CHANNEL_1 | TIM_CHANNEL_2);

}

//基本定时器中断启动 Basic timer interrupt start
void Tim_Base_Init(void)
{
	//启动定时6中断 Start timing 6 interrupt
	HAL_TIM_Base_Start_IT(&htim6);

	//启动定时7中断 Start timing 7 interrupt
	HAL_TIM_Base_Start_IT(&htim7);
}





extern uint32_t ultrasonic_num;
extern uint8_t ultrasonic_flag;

int send_time = 1;//发送计时变量 Sending timing variables
//基本定时器中断回调函数 Basic timer interrupt callback function
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
	if (htim->Instance == TIM6)//10ms
	{
		Encoder_Update_Count();//10ms测速 10ms speed measurement
		Motion_Handle();//调用PID控制速度 Calling PID control speed

		if(send_time>0)
		{
			send_time --;
		}
		else
		{
			send_time = 1;
		}


	}


	if (htim->Instance == TIM7)//10us
	{
		if(g_servo_falg == 1)
		{
			PwmServo_Handle();//舵机控制 Steering gear control
		}


		if(ultrasonic_flag) //开始测距--超声波 Start ranging - ultrasonic
		{
			ultrasonic_num++;
		}
	}
}



