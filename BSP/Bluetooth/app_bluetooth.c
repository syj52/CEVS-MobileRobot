#include "app_bluetooth.h"

#define BLUEDEBUG 0


extern uint8_t newLineReceived;//引入标志 Introduction Flag
extern uint8_t g_modeSelect;//引入模式标志 Introduction Mode Flag

uint8_t ProtocolString[80] = {0};//备份数据区 Backup Data Area


void USE_Bluetooth_Control(void)
{
	if (newLineReceived)
	{
		#if BLUEDEBUG == 0
			Get_Data();
		#else
			Copy_Bluetooth_Data();
			printf("%s\r\n",ProtocolString);
		#endif

		newLineReceived = 0;//确保清0 Ensure clear 0
	}
	// 切换不同功能模式, 功能模式显示 Switch between different function modes, and display the function mode
	switch (g_modeSelect)
	{
		case 1: break; 			//暂时保留 Temporarily reserved
		case 2: car_irtrack(); break; 			//巡线模式 Patrol mode
		case 3:	Ir_Ultrasonic_avoid(20);OLED_SHOW_DIS(); break;  		//超声波避障模式 Ultrasonic obstacle avoidance mode
		case 4: RGB_color_water(0,200);HAL_Delay(20);RGB_color_water(1,200);HAL_Delay(20);break;
		case 5: break;
		case 6: Ultrasonic_follow(45,20);OLED_SHOW_DIS();	break;	//跟随模式 Follow Mode
		default:break;
	}


}

char send_buf[60]={'\0'};

//函数功能:发送一些数据给上位机
//Function function: Send some data to the upper computer
void Send_Msg(void)
{
	float CarBAT = (Adc_Get_Battery_Volotage()*1.62); //电池电量  把7.4v变成12V 因为app的电量是0-12 The battery level has changed from 7.4V to 12V because the app's battery level is 0-12
	float CarDis = Get_distance();
	int IR_State = GetLineWalking_Data();
	int IR_Dis_State = Get_Iraviod_App();

	sprintf(send_buf,"$4WD,CSB%.2f,PV%1.2f,GS255,LF%04d,HW%02d,GM00#",CarDis,CarBAT,IR_State,IR_Dis_State);

	USRT5_DataString((uint8_t *)send_buf,strlen(send_buf));
	memset(send_buf,0,sizeof(send_buf));

}


char OLED_buf[20]={'\0'};

void OLED_SHOW_BAT(void)
{
	//oled显示小车电池电量 OLED displays the battery level of the car
	sprintf(OLED_buf,"CarBAT:%.2fV   ",Adc_Get_Battery_Volotage());
	OLED_Draw_Line(OLED_buf, 2, false, true);
}

void OLED_SHOW_Car_Speed(void)
{
	//oled显示小车当前的速度 OLED displays the current speed of the car
	sprintf(OLED_buf,"car_speed:%d  ",CarSpeedControl);
	OLED_Draw_Line(OLED_buf, 3, false, true);
}

void OLED_SHOW_DIS(void)
{
	//oled显示超声波距离 OLED displays ultrasonic distance
	sprintf(OLED_buf,"dis:%.1f cm     ",Get_distance());
	OLED_Draw_Line(OLED_buf, 3, false, true);
}

void OLED_SHOW_IRDIS(void)
{
	//oled显示红外避障的值  OLED displays the value of infrared obstacle avoidance
	uint16_t IRleft_data = 0;
	uint16_t IRright_data = 0;
	Get_Iravoid_Data(&IRleft_data,&IRright_data);
	sprintf(OLED_buf,"L:%d    R:%d   ",IRleft_data,IRright_data);
	OLED_Draw_Line(OLED_buf, 1, false, true);
}

