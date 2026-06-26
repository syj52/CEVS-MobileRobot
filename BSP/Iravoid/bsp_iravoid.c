#include "bsp_iravoid.h"

//函数功能:红外避障开关
//传入参数：ENABLE DISABLE

//Function function: infrared obstacle avoidance switch
//Incoming parameters :ENABLE DISABLE
void IR_SWitch(uint8_t state)
{
	//打开传感器 -低电平打开
	//Open sensor - low level open
	if(state == ENABLE)
		HAL_GPIO_WritePin(GPIOE, Left_Switch_Iravoid_Pin|Right_Switch_Iravoid_Pin, GPIO_PIN_RESET);
	else
	{
		HAL_GPIO_WritePin(GPIOE, Left_Switch_Iravoid_Pin|Right_Switch_Iravoid_Pin, GPIO_PIN_SET);
	}

}


/*
 * 采集传感器的电压
 *
 *Collect the voltage of the sensor
 * */
uint16_t Adc_Get_Iravoid(uint32_t ch)
{
  ADC_ChannelConfTypeDef sConfig = {0};
  sConfig.Channel = ch;
  sConfig.Rank = ADC_REGULAR_RANK_1;
  sConfig.SamplingTime = ADC_SAMPLETIME_239CYCLES_5;
  if (HAL_ADC_ConfigChannel(&hadc3, &sConfig) != HAL_OK)
  {
	Error_Handler();
  }

	HAL_ADC_Start(&hadc3);
	HAL_ADC_PollForConversion(&hadc3, 500);
	return HAL_ADC_GetValue(&hadc3);
}


/*
 * 串口打印采集的数据
 *
 *Serial port printing of collected data
 * */
void Get_Iravoid_Data(uint16_t *left_data,uint16_t *right_data)
{

	*left_data =  Adc_Get_Iravoid(IR_Left_CH);
	*right_data = Adc_Get_Iravoid(IR_Right_CH);

	printf("L1:%d     R1:%d \r\n",*left_data,*right_data);

}
