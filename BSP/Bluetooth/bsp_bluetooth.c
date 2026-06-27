/*
 * 这是一个处理蓝牙发过来的信息，并非驱动蓝牙的文件
 * This is a file that processes information sent by Bluetooth, not the driver of Bluetooth
 */

#include "bsp_bluetooth.h"
#include "bsp_usart1.h"


#define 	run_car     '1'//按键前 Before pressing the button
#define 	back_car    '2'//按键后 After pressing the button
#define 	left_car    '3'//按键左 Left button
#define 	right_car   '4'//按键右 Right button
#define 	stop_car    '0'//按键停 Button stop


int g_num = 0;
uint8_t startBit = 0;
int g_packnum = 0;
int CarSpeedControl = 500;//小车速度  speed of a motor vehicle

uint8_t newLineReceived = 0;
uint8_t inputString[80] = {0}; //接收数据区 Receiving data area
extern uint8_t ProtocolString[80];//引入备份数据区 Introducing backup data area

motion_state_t g_CarState = MOTION_STOP;
uint8_t g_modeSelect = 0;  //0是默认APK上位机状态; 1:红外遥控 2:巡线模式 3:超声波避障  6: 超声波跟踪 //0 is the default APK upper computer state; 1: Infrared remote control 2: Line patrol mode 3: Ultrasonic obstacle avoidance 6: Ultrasonic tracking

#define BLUETOOTH_CMD_TIMEOUT_MS 800U

static uint32_t g_last_valid_cmd_tick = 0;
static uint8_t  g_has_valid_cmd = 0;
static uint8_t  g_timeout_stop_done = 0;

/* Return one execution marker to ESP32 after a complete official Bluetooth frame
 * has been parsed and the original motor command handler has been called.
 * This does not change the official motion mode; it only reports what command
 * entered Deal_Motor_Data().
 */
static void USART1_Send_EXEC_From_Protocol(void)
{
	char exec_cmd = 'S';
	static char exec_buf[16]; /* DMA safe */
	int len;

	if (ProtocolString[3] == '1')
	{
		exec_cmd = 'Q';
	}
	else if (ProtocolString[3] == '2')
	{
		exec_cmd = 'E';
	}
	else
	{
		switch (ProtocolString[1])
		{
			case run_car:   exec_cmd = 'F'; break;
			case back_car:  exec_cmd = 'B'; break;
			case left_car:  exec_cmd = 'L'; break;
			case right_car: exec_cmd = 'R'; break;
			case stop_car:  exec_cmd = 'S'; break;
			default:        exec_cmd = '?'; break;
		}
	}

	len = sprintf(exec_buf, "EXEC:%c\r\n", exec_cmd);
	USART1_Send((uint8_t *)exec_buf, (uint16_t)len);
}

static uint8_t Bluetooth_Is_Valid_Motor_Frame(void)
{
    char move_cmd = ProtocolString[1];  // $1,0,0,...# 中的 1
    char spin_cmd = ProtocolString[3];  // $0,1,0,...# 中的 1/2，原工程用于左旋/右旋

    if (ProtocolString[0] != '$')
    {
        return 0;
    }

    if (!(move_cmd == '0' ||
          move_cmd == '1' ||
          move_cmd == '2' ||
          move_cmd == '3' ||
          move_cmd == '4'))
    {
        return 0;
    }

    if (!(spin_cmd == '0' ||
          spin_cmd == '1' ||
          spin_cmd == '2'))
    {
        return 0;
    }

    return 1;
}

//函数功能:处理接收蓝牙的数据
//传入参数:串口的接收信息
//Function function: Process and receive Bluetooth data
//Incoming parameter: receiving information of the serial port
void Deal_Bluetooth(uint8_t msg)
{
    // 上一帧还没被主循环处理，先不要覆盖缓存
    if (newLineReceived)
    {
        return;
    }

    if (msg == '$')
    {
        startBit = 1;
        g_num = 0;
        memset(inputString, 0x00, sizeof(inputString));
    }

    if (startBit == 0)
    {
        return;
    }

    if (g_num < sizeof(inputString) - 1)
    {
        inputString[g_num] = msg;
    }
    else
    {
        g_num = 0;
        startBit = 0;
        newLineReceived = 0;
        memset(inputString, 0x00, sizeof(inputString));
        return;
    }

    if (msg == '#')
    {
        g_packnum = g_num;
        inputString[g_num + 1] = '\0';
        newLineReceived = 1;
        startBit = 0;
        return;
    }

    g_num++;
}


//串口数据拷贝到新的buf中防止处理过程中被新数据覆盖
//Copy serial data to a new BUF to prevent it from being overwritten by new data during processing
void Copy_Bluetooth_Data(void)
{
	memcpy(ProtocolString, inputString, g_packnum + 1);
	memset(inputString, 0x00, sizeof(inputString));
}

/*
 * 函数功能:字符串查找
 * pSrc:源字符串; pDst:查找的字符串; v_iStartPos:源字符串起始位置
 *Function function: String lookup
 *PSrc: Source string; PDst: The string to search for; V_ IStartPos: Source string start position
 */
int StringFind(const char *pSrc, const char *pDst, int v_iStartPos)
{
    int i, j;
    for (i = v_iStartPos; pSrc[i]!='\0'; i++)
    {
        if(pSrc[i]!=pDst[0])
            continue;
        j = 0;
        while(pDst[j] !='\0' && pSrc[i+j]!='\0')
        {
            j++;
            if(pDst[j]!=pSrc[i+j])
            break;
        }
        if(pDst[j]=='\0')
            return i;
    }
    return -1;
}

//函数功能,根据协议取数据
//Function function, fetching data according to protocol
void Get_Data(void)
{
	Copy_Bluetooth_Data();
	//常用 in common use
	if (StringFind((const char *)ProtocolString, (const char *)"4WD", 0) == -1)
	{
		Deal_Motor_Data();
		USART1_Send_EXEC_From_Protocol();
		Deal_Servo_RGB_BEEP_Data();
		newLineReceived = 0;
		memset(ProtocolString, 0x00, sizeof(ProtocolString));
		return ;
	}

	//RGB的颜色-app滑动条控制 RGB color - app slider control
	 if (StringFind((const char *)ProtocolString, (const char *)"CLR", 0) > 0)
	{
		 Deal_RGB_Data();
		 newLineReceived = 0;
		 memset(ProtocolString, 0x00, sizeof(ProtocolString));
		 return ;
	}

	 //舵机云台控制-只有左右 Steering gear pan tilt control - only left and right
	 if (StringFind((const char *)ProtocolString, (const char *)"PTZ", 0) > 0)
	 {
		 Deal_PWM_Servo();
		 newLineReceived = 0;
		 memset(ProtocolString, 0x00, sizeof(ProtocolString));
		 return ;
	 }

	//模式处理 Mode Handler
	if(StringFind((const char *)ProtocolString, (const char *)"MODE", 0) > 0
		&& StringFind((const char *)ProtocolString, (const char *)"4WD", 0) > 0)
	{
		Deal_Mode();
		newLineReceived = 0;
		memset(ProtocolString, 0x00, sizeof(ProtocolString));
		return ;
	}


}

//函数功能:处理小车的运动控制
//Function function: Handle the motion control of the car
//eg:$1,0,0,0,0,0,0,0,0,0#    小车前进 Trolley forward
void Deal_Motor_Data(void)
{
	//小车左旋右旋判断 Left and right rotation judgment of the car
	if (ProtocolString[3] == '1')      //小车左旋 Left rotation of the car
	{
		g_CarState = MOTION_SPIN_LEFT;
	}
	else if (ProtocolString[3] == '2') //小车右旋 Car turning right
	{
		g_CarState = MOTION_SPIN_RIGHT;
	}
	else
	{
		g_CarState = MOTION_STOP;
	}

	//小车加减速判断 Car acceleration and deceleration judgment
	if (ProtocolString[7] == '1')    //加速，每次加100 Accelerate by adding 100 each time
	{
		CarSpeedControl += 100;
		if (CarSpeedControl > 1000)
		{
			CarSpeedControl = 1000;
		}
	}
	if (ProtocolString[7] == '2')	//减速，每次减100 Reduce speed by 100 each time
	{
		CarSpeedControl -= 100;
		if (CarSpeedControl < 100)
		{
			CarSpeedControl = 100;
		}
	}

	//小车的前进,后退,左转,右转,停止动作 The forward, backward, left, right, and stop movements of the car
	if (g_CarState != MOTION_SPIN_LEFT && g_CarState != MOTION_SPIN_RIGHT)
	{
		switch (ProtocolString[1])
		{
			case run_car:   g_CarState = MOTION_RUN;  break;
			case back_car:  g_CarState = MOTION_BACK;  break;
			case left_car:  g_CarState = MOTION_LEFT;  break;
			case right_car: g_CarState = MOTION_RIGHT;  break;
			case stop_car:  g_CarState = MOTION_STOP;  break;
			default: g_CarState = MOTION_STOP; break;
		}
	}
		wheel_State_YAW(g_CarState,CarSpeedControl,0);

}

//函数功能:处理RGB和蜂鸣器的数据 Function function: Process RGB and buzzer data
//eg:$0,0,0,0,0,1,0,0,0,0#    小车鸣笛 Car whistles
void Deal_Servo_RGB_BEEP_Data(void)
{
	//小车鸣笛判断 Car whistle judgment
	if (ProtocolString[5] == '1')     //鸣笛 whistle
	{
		whistle();
	}
	//点灯判断 Lighting judgment
	if (ProtocolString[13] == '1')//七彩灯亮白色 Colorful light on white
	{
		Set_RGB(RGB_Max, write);
	}
	else if (ProtocolString[13] == '2')//七彩灯亮红色 Colorful lights in red
	{
		Set_RGB(RGB_Max, red);
	}
	else if (ProtocolString[13] == '3')//七彩灯亮绿灯 Colorful light on green light
	{
		Set_RGB(RGB_Max, green);
	}
	else if (ProtocolString[13] == '4') //七彩灯亮蓝灯 Colorful light, bright blue light
	{
		Set_RGB(RGB_Max, blue);
	}
	else if (ProtocolString[13] == '5') //七彩灯亮青色 Colorful light bright blue
	{
		Set_RGB(RGB_Max, lake);
	}
	else if (ProtocolString[13] == '6') //七彩灯亮品红 Colorful light bright magenta
	{
		Set_RGB(RGB_Max, purple);
	}
	else if (ProtocolString[13] == '7') //七彩灯亮黄色 Colorful light in yellow
	{
		Set_RGB(RGB_Max, yellow);
	}
	else if (ProtocolString[13] == '8') //七彩灯灭 Colorful lights out
	{
		RGB_OFF_ALL;
	}

	if (ProtocolString[9] == '1') //舵机旋转到180度 The steering gear rotates to 180 degrees
	{
		PwmServo_Set_Angle(S1_SERVO, 180);
	}
	if (ProtocolString[9] == '2') //舵机旋转到0度 The steering gear rotates to 0 degrees
	{
		PwmServo_Set_Angle(S1_SERVO, 0);
	}
	if (ProtocolString[17] == '1') //舵机旋转到90度 The steering gear rotates to 90 degrees
	{
		PwmServo_Set_Angle(S1_SERVO, 90);
	}

}

//函数功能:处理RGB的数据 Function function: Processing RGB data
//eg:$4WD,CLR255,CLG0,CLB0# 七彩灯亮红色 Colorful lights in red
//只能亮颜色，颜色的亮度调节不了 Can only brighten the color, the brightness of the color cannot be adjusted
void Deal_RGB_Data(void)
{
	uint16_t m_kp, i, ii, red, green, blue;
	static char m_skp[5] = {0};

	i = StringFind((const char *)ProtocolString, (const char *)"CLR", 0);
	ii = StringFind((const char *)ProtocolString, (const char *)",", i);
	if (ii > i)
	{
		memcpy(m_skp, ProtocolString + i + 3, ii - i -3);
		m_kp = atoi(m_skp);
		red =   m_kp;
	}
	i = StringFind((const char *)ProtocolString, (const char *)"CLG", 0);
	ii = StringFind((const char *)ProtocolString, (const char *)",", i);
	if (ii > i)
	{
		memcpy(m_skp, ProtocolString + i + 3, ii - i -3);
		m_kp = atoi(m_skp);
		green =   m_kp;
	}
	i = StringFind((const char *)ProtocolString, (const char *)"CLB", 0);
	ii = StringFind((const char *)ProtocolString, (const char *)"#", i);
	if (ii > i)
	{
		memcpy(m_skp, ProtocolString + i + 3, ii - i -3);
		m_kp = atoi(m_skp);
		blue =  m_kp;
	}
	Colorful_RGB(red, green, blue);//点亮相应颜色的灯 Illuminate the corresponding colored lights

}

//函数功能:进行模式判断 Function function: Perform pattern judgment
void Deal_Mode(void)
{
	if (ProtocolString[10] == '0') //停止模式 STOP MODE
	{
		wheel_State_YAW(MOTION_STOP,0,0);
		g_CarState = MOTION_STOP;
		RGB_OFF_ALL;
		g_modeSelect = 0;
		BeepOnOffMode();
	}
	else
	{
		switch (ProtocolString[9])
		{
			case '0': break;
			case '1': g_modeSelect = 1; ModeBEEP(1); break; //遥控模式 Remote Control Mode
			case '2': g_modeSelect = 2; ModeBEEP(2); break; //巡线模式 Patrol mode
			case '3': g_modeSelect = 3; ModeBEEP(3); break; //避障模式 Obstacle avoidance mode
			case '4': g_modeSelect = 4; ModeBEEP(4); break; //7彩探照灯模式
			case '5': break;
			case '6': g_modeSelect = 6; ModeBEEP(6); break; //跟随模式 Follow Mode
			default: g_modeSelect = 0; break;
		}
	}
}

//舵机云台控制 Steering gear pan tilt control
//eg:$4WD,PTZ180# 舵机转动到180度 The steering gear rotates to 180 degrees
void Deal_PWM_Servo(void)
{
	int m_kp, i, ii;

	i = StringFind((const char *)ProtocolString, (const char *)"PTZ", 0); //寻找以PTZ开头,#结束中间的字符 Find characters starting with PTZ and ending with # in the middle
	ii = StringFind((const char *)ProtocolString, (const char *)"#", i);
	if (ii > i)
	{
		char m_skp[5] = {0};
		memcpy(m_skp, ProtocolString + i + 3, ii - i -3);

		m_kp = atoi(m_skp);        //将找到的字符串变成整型 Convert the found string to integer
		PwmServo_Set_Angle(S1_SERVO, m_kp);//转动S1舵机 Rotate S1 steering gear
	}

}
