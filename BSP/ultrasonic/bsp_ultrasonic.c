#include <bsp_ultrasonic.h>


uint32_t ultrasonic_num = 0;
uint8_t ultrasonic_flag = 0;		//0:没开始测距  1:开始测距 0: Ranging not started 1: Ranging started

volatile uint8_t g_us_timeout_reason = 0; /* 0=OK, 1=ECHO未上升, 2=ECHO未下降 */


/*
 * 得到测5次平均值
 *
 * Get the average of 5 measurements
 * */
float Get_distance(void)
{
	float distance = 0, aveg = 0;
	uint16_t tim, count;
	uint8_t valid = 0;        /* 成功采样次数 */
	uint8_t tries = 0;        /* 总尝试次数 */
#define MAX_TRIES  10         /* 最多尝试 10 次 */
#define MIN_VALID   5         /* 至少收集 5 次有效采样 */

	while(valid < MIN_VALID && tries < MAX_TRIES)
	{
		tries++;

		HAL_GPIO_WritePin(TRIG_GPIO_Port, TRIG_Pin,GPIO_PIN_SET);
		Delay_US(20); 
		HAL_GPIO_WritePin(TRIG_GPIO_Port, TRIG_Pin,GPIO_PIN_RESET);

		/* 启动 TIM7 计数, 等待 ECHO 上升沿, 带超时保护 */
		ultrasonic_num = 0;
		ultrasonic_flag = 1;
		while(HAL_GPIO_ReadPin(ECHO_GPIO_Port, ECHO_Pin) == GPIO_PIN_RESET)
		{
			if(ultrasonic_num >= 10000)
			{
				g_us_timeout_reason = 1;
				goto skip_sample;
			}
		}

		/* ECHO 上升沿: 清零计数器, 只测回波脉冲宽度, 不包含模块预处理时间 */
		ultrasonic_num = 0;

		/* 等待 ECHO 下降沿 */
		while(HAL_GPIO_ReadPin(ECHO_GPIO_Port, ECHO_Pin) == GPIO_PIN_SET)
		{
			count = ultrasonic_num;
			if(count >= 10000)
			{
				g_us_timeout_reason = 2;
				goto skip_sample;
			}
		}

		/* 本次采样成功 */
		ultrasonic_flag = 0;
		tim = TIM7->CNT;
		distance = (tim + ultrasonic_num * 10) / 58.5;
		aveg += distance;
		valid++;

	skip_sample:
		ultrasonic_flag = 0;
		ultrasonic_num = 0;
		HAL_Delay(20);   /* 给模块足够的恢复时间 */
	}

	if(valid == 0)
	{
		/* 全部超时, 保留 g_us_timeout_reason (最后一次失败原因) */
		return 0.0f;
	}

	g_us_timeout_reason = 0;   /* 至少有一次有效, 整体视为成功 */
	return aveg / valid;       /* 用实际有效次数做平均 */
}

