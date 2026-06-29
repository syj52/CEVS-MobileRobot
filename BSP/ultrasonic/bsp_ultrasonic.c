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
	float distance = 0,aveg = 0;
	uint16_t tim,count;
	uint8_t i = 0;

	while(i != 5)
	{
		HAL_GPIO_WritePin(TRIG_GPIO_Port, TRIG_Pin,GPIO_PIN_SET);
		Delay_US(10); /* 必须是 10us, 20us 会导致 Yahboom 模块不响应 */
		HAL_GPIO_WritePin(TRIG_GPIO_Port, TRIG_Pin,GPIO_PIN_RESET);

		/* 启动 TIM7 计数, 等待 ECHO 上升沿, 带超时保护 */
		ultrasonic_num = 0;
		ultrasonic_flag = 1;
		while(HAL_GPIO_ReadPin(ECHO_GPIO_Port, ECHO_Pin) == GPIO_PIN_RESET)
		{
			if(ultrasonic_num >= 10000)
			{
				ultrasonic_flag = 0;
				ultrasonic_num = 0;
				g_us_timeout_reason = 1;
				return 0;
			}
		}

		i+=1;
		while(HAL_GPIO_ReadPin(ECHO_GPIO_Port, ECHO_Pin) == GPIO_PIN_SET)
		{
			count = ultrasonic_num;
			if(count >= 10000)
			{
				ultrasonic_flag = 0;
				ultrasonic_num = 0;
				g_us_timeout_reason = 2;
				return 0;
			}
		}

		ultrasonic_flag = 0;
		tim = TIM7->CNT;
		g_us_timeout_reason = 0;  /* 测距成功, 清零超时标�? */
		distance = (tim + ultrasonic_num * 10) / 58.5;
		aveg = distance + aveg;
		ultrasonic_num = 0;
		HAL_Delay(10);
	}
	distance = aveg / 5;
	return distance;
}

