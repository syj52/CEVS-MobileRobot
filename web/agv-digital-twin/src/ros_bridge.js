import * as ROSLIB from 'roslib';
import * as THREE from 'three';

export class AGVROSBridge {
    constructor(scene) {
        this.scene = scene;
        this.agvMesh = null;
        
        // 创建一个代表小车的绿色方块
        const geometry = new THREE.BoxGeometry(0.6, 0.3, 0.4);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: false });
        this.agvMesh = new THREE.Mesh(geometry, material);
        
        // 在方块前面加一个红色小方块代表“车头”
        const noseGeo = new THREE.BoxGeometry(0.2, 0.3, 0.1);
        const noseMat = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const nose = new THREE.Mesh(noseGeo, noseMat);
        nose.position.set(0.4, 0, 0); // 车头朝前
        this.agvMesh.add(nose);
        
        // 将小车加入到 3DGS 的 Three.js 场景中
        this.scene.add(this.agvMesh);
        
        this.connect();
    }
    
    connect() {
        // 连接到 ROS 2 的 rosbridge websocket 服务器
        this.ros = new ROSLIB.Ros({
            url : 'ws://localhost:9090'
        });

        this.ros.on('connection', () => {
            console.log('✅ 成功连接到 ROS 2 WebSocket 服务器!');
        });

        this.ros.on('error', (error) => {
            console.error('❌ ROS 2 连接出错: 请确保已运行 rosbridge_server', error);
        });

        this.ros.on('close', () => {
            console.log('⚠️ ROS 2 连接已关闭.');
        });
        
        // 订阅 /odom (里程计) 话题获取小车实时坐标
        this.odomListener = new ROSLIB.Topic({
            ros : this.ros,
            name : '/odom',
            messageType : 'nav_msgs/Odometry'
        });

        this.odomListener.subscribe((message) => {
            const pos = message.pose.pose.position;
            const ori = message.pose.pose.orientation;
            
            // 【重要】坐标系转换
            // ROS 2 默认是右手系 Z轴朝上 (X前, Y左, Z上)
            // Three.js 默认是右手系 Y轴朝上 (X右, Y上, Z外)
            // 由于 3DGS 的点云经过了处理，这里需要你根据实际画面显示的相对位置进行微调 (x, y, z 轴的映射)
            
            // 假设一种常见的映射关系 (需根据你的 3DGS 实际朝向修改):
            // 此处用 pos.x 映射 Three 的 X，pos.z 映射 Y (高度)，-pos.y 映射 Z
            this.agvMesh.position.set(pos.x, pos.z + 0.2, -pos.y);
            
            // 四元数旋转转换 (对应上述位置转换)
            const quaternion = new THREE.Quaternion(ori.x, ori.z, -ori.y, ori.w);
            this.agvMesh.setRotationFromQuaternion(quaternion);
        });
    }
}
