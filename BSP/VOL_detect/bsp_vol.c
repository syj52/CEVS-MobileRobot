#include "bsp_vol.h"

uint16_t Get_BAT(uint32_t ch)
{
	ADC_ChannelConfTypeDef sConfig = {0};
	sConfig.Channel = ch;
	sConfig.Rank = ADC_REGULAR_RANK_1;
	sConfig.SamplingTime = ADC_SAMPLETIME_239CYCLES_5;
	if (HAL_ADC_ConfigChannel(&hadc3, &sConfig) != HAL_OK)
	{
		Error_Handler();
	}

	HAL_ADCEx_Calibration_Start(&hadc3);//校正
	HAL_ADC_Start(&hadc3);
	HAL_ADC_PollForConversion(&hadc3, 500);
	return HAL_ADC_GetValue(&hadc3);
}

// 获得 ADC 多次测量平均值 times:测量次数
// Obtain the average of multiple ADC measurements times: number of measurements
uint16_t Adc_Get_Average(uint32_t ch, uint8_t times)
{
	uint16_t temp_val = 0;
	uint8_t t;
	for (t = 0; t < times; t++)
	{
		temp_val += Get_BAT(ch);
	}
	if (times == 4)
	{
		temp_val = temp_val >> 2;
	}
	else
	{
		temp_val = temp_val / times;
	}
	return temp_val;
}

// 获得测得原始电压值
// Obtain the measured original voltage value
float Adc_Get_Measure_Volotage(void)
{
	uint16_t adcx;
	float temp;
	adcx = Adc_Get_Average(BAT_CH, 4);
	temp = (float)adcx * (3.30f / 4096);
	return temp;
}

// 获得实际电池分压前电压
// Obtain the actual voltage before battery partial voltage
float Adc_Get_Battery_Volotage(void)
{
	float temp;
	temp = Adc_Get_Measure_Volotage();
	// 实际测量的值比计算得出的值低一点点。
	// The actual measured value is slightly lower than the calculated value.
	temp = temp * 4.03f; // temp*(10+3.3)/3.3;
	return temp;
}
